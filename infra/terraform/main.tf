data "azurerm_client_config" "current" {}

resource "random_string" "suffix" {
  length  = 5
  upper   = false
  special = false
}

locals {
  base = "${var.name_prefix}-${var.environment}"
  # Key Vault names are global and limited to 24 chars.
  kv_name = substr(replace("${var.name_prefix}${var.environment}${random_string.suffix.result}", "-", ""), 0, 24)

  # Deterministic names so the API access restriction and the gateway upstream do not form a dependency cycle.
  api_name     = "${local.base}-api-${random_string.suffix.result}"
  gateway_name = "${local.base}-gw-${random_string.suffix.result}"
  worker_name  = "${local.base}-worker-${random_string.suffix.result}"

  tags = merge({
    app         = "opsbridge"
    environment = var.environment
    managed_by  = "terraform"
  }, var.extra_tags)

  # Key Vault reference syntax: App Service resolves it with the app's managed identity at runtime.
  kv_ref = { for k, v in azurerm_key_vault_secret.app : k => "@Microsoft.KeyVault(SecretUri=${v.versionless_id})" }
}

resource "azurerm_resource_group" "main" {
  name     = "rg-${local.base}"
  location = var.location
  tags     = local.tags
}

# ---------- Observability: one workspace for logs, metrics and App Insights ----------
resource "azurerm_log_analytics_workspace" "main" {
  name                = "log-${local.base}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "PerGB2018"
  retention_in_days   = var.environment == "prod" ? 90 : 30
  tags                = local.tags
}

resource "azurerm_application_insights" "main" {
  name                = "appi-${local.base}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  workspace_id        = azurerm_log_analytics_workspace.main.id
  application_type    = "Node.JS"
  tags                = local.tags
}

# ---------- Secrets: Key Vault with RBAC (no access policies) ----------
resource "azurerm_key_vault" "main" {
  name                          = local.kv_name
  location                      = azurerm_resource_group.main.location
  resource_group_name           = azurerm_resource_group.main.name
  tenant_id                     = data.azurerm_client_config.current.tenant_id
  sku_name                      = "standard"
  rbac_authorization_enabled    = true
  purge_protection_enabled      = var.environment == "prod"
  soft_delete_retention_days    = 14
  tags                          = local.tags
  public_network_access_enabled = !var.private_only
}

# The identity running Terraform may write secrets; applications may only read them (below).
resource "azurerm_role_assignment" "deployer_secrets" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "random_password" "jwt" {
  length  = 48
  special = false
}

resource "random_password" "internal_key" {
  length  = 40
  special = false
}

resource "azurerm_key_vault_secret" "app" {
  for_each = {
    "jwt-secret"        = random_password.jwt.result
    "internal-key"      = random_password.internal_key.result
    "mongo-url"         = azurerm_cosmosdb_account.main.primary_mongodb_connection_string
    "kafka-sasl-secret" = azurerm_eventhub_namespace.main.default_primary_connection_string
  }
  name         = each.key
  value        = each.value
  key_vault_id = azurerm_key_vault.main.id
  content_type = "application/opsbridge-secret"

  depends_on = [azurerm_role_assignment.deployer_secrets]
}

# ---------- Data tier: Cosmos DB for MongoDB (wire-compatible with the application's Mongoose models) ----------
resource "azurerm_cosmosdb_account" "main" {
  name                          = "cosmos-${local.base}-${random_string.suffix.result}"
  location                      = azurerm_resource_group.main.location
  resource_group_name           = azurerm_resource_group.main.name
  offer_type                    = "Standard"
  kind                          = "MongoDB"
  public_network_access_enabled = !var.private_only

  mongo_server_version         = "7.0"
  local_authentication_enabled = true # Mongo wire protocol needs the connection string; it lives only in Key Vault.
  minimal_tls_version          = "Tls12"

  capabilities {
    name = "EnableMongo"
  }
  capabilities {
    name = "EnableServerless"
  }

  consistency_policy {
    consistency_level = "Session"
  }

  geo_location {
    location          = azurerm_resource_group.main.location
    failover_priority = 0
  }

  backup {
    type = "Continuous"
    tier = "Continuous7Days"
  }

  tags = local.tags
}

resource "azurerm_cosmosdb_mongo_database" "main" {
  name                = "opsbridge"
  resource_group_name = azurerm_resource_group.main.name
  account_name        = azurerm_cosmosdb_account.main.name
}

# ---------- Event backbone: Event Hubs speaks the Kafka protocol, so kafkajs works unchanged ----------
resource "azurerm_eventhub_namespace" "main" {
  name                          = "evhns-${local.base}-${random_string.suffix.result}"
  location                      = azurerm_resource_group.main.location
  resource_group_name           = azurerm_resource_group.main.name
  sku                           = "Standard"
  capacity                      = 1
  minimum_tls_version           = "1.2"
  tags                          = local.tags
  public_network_access_enabled = !var.private_only
}

resource "azurerm_eventhub" "events" {
  for_each          = toset(["incident.events", "incident.events.dlq"])
  name              = each.key
  namespace_id      = azurerm_eventhub_namespace.main.id
  partition_count   = 2
  message_retention = 1
}

resource "azurerm_eventhub_consumer_group" "worker" {
  name                = "opsbridge-worker"
  namespace_name      = azurerm_eventhub_namespace.main.name
  eventhub_name       = azurerm_eventhub.events["incident.events"].name
  resource_group_name = azurerm_resource_group.main.name
}

# ---------- Compute: App Service (Linux containers) ----------
resource "azurerm_service_plan" "main" {
  name                = "asp-${local.base}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  os_type             = "Linux"
  sku_name            = var.app_service_sku
  tags                = local.tags
}

locals {
  common_settings = {
    NODE_ENV                              = "production"
    WEBSITES_ENABLE_APP_SERVICE_STORAGE   = "false"
    APPLICATIONINSIGHTS_CONNECTION_STRING = azurerm_application_insights.main.connection_string
    KAFKA_BROKERS                         = "${azurerm_eventhub_namespace.main.name}.servicebus.windows.net:9093"
    KAFKA_SSL                             = "true"
    KAFKA_SASL_USERNAME                   = "$ConnectionString"
    KAFKA_SASL_PASSWORD                   = local.kv_ref["kafka-sasl-secret"]
    KAFKA_CREATE_TOPICS                   = "false"
    DOCKER_REGISTRY_SERVER_URL            = "https://${var.container_registry}"
  }
}

resource "azurerm_linux_web_app" "api" {
  name                      = local.api_name
  location                  = azurerm_resource_group.main.location
  resource_group_name       = azurerm_resource_group.main.name
  service_plan_id           = azurerm_service_plan.main.id
  https_only                = true
  virtual_network_subnet_id = azurerm_subnet.integration.id
  tags                      = local.tags

  identity {
    type = "SystemAssigned"
  }

  site_config {
    always_on                               = true
    health_check_path                       = "/healthz"
    health_check_eviction_time_in_min       = 5
    minimum_tls_version                     = "1.2"
    ftps_state                              = "Disabled"
    vnet_route_all_enabled                  = false
    container_registry_use_managed_identity = true

    application_stack {
      docker_image_name   = "opsbridge-api:${var.image_tag}"
      docker_registry_url = "https://${var.container_registry}"
    }

    # Only the gateway may call the API: the entry-point enforcement cannot be bypassed from the internet.
    ip_restriction_default_action = "Deny"
    dynamic "ip_restriction" {
      for_each = toset(azurerm_linux_web_app.gateway.possible_outbound_ip_address_list)
      content {
        name       = "gateway-${replace(ip_restriction.value, ".", "-")}"
        ip_address = "${ip_restriction.value}/32"
        action     = "Allow"
        priority   = 100 + index(azurerm_linux_web_app.gateway.possible_outbound_ip_address_list, ip_restriction.value)
      }
    }
  }

  app_settings = merge(local.common_settings, {
    PORT          = "3000"
    WEBSITES_PORT = "3000"
    AUTH_MODE     = "gateway"
    MONGO_URL     = local.kv_ref["mongo-url"]
    INTERNAL_KEY  = local.kv_ref["internal-key"]
    ENABLE_CHAOS  = var.environment == "prod" ? "false" : "true"
  })
}

resource "azurerm_linux_web_app" "gateway" {
  name                      = local.gateway_name
  location                  = azurerm_resource_group.main.location
  resource_group_name       = azurerm_resource_group.main.name
  service_plan_id           = azurerm_service_plan.main.id
  https_only                = true
  virtual_network_subnet_id = azurerm_subnet.integration.id
  tags                      = local.tags

  identity {
    type = "SystemAssigned"
  }

  site_config {
    always_on                               = true
    health_check_path                       = "/healthz"
    minimum_tls_version                     = "1.2"
    ftps_state                              = "Disabled"
    vnet_route_all_enabled                  = false
    container_registry_use_managed_identity = true

    application_stack {
      docker_image_name   = "opsbridge-gateway:${var.image_tag}"
      docker_registry_url = "https://${var.container_registry}"
    }
  }

  app_settings = merge(local.common_settings, {
    PORT          = "8080"
    WEBSITES_PORT = "8080"
    UPSTREAM_URL  = "https://${local.api_name}.azurewebsites.net"
    AUTH_MODE     = "local"
    JWT_SECRET    = local.kv_ref["jwt-secret"]
    INTERNAL_KEY  = local.kv_ref["internal-key"]
  })
}

resource "azurerm_linux_web_app" "worker" {
  name                      = local.worker_name
  location                  = azurerm_resource_group.main.location
  resource_group_name       = azurerm_resource_group.main.name
  service_plan_id           = azurerm_service_plan.main.id
  https_only                = true
  virtual_network_subnet_id = azurerm_subnet.integration.id
  tags                      = local.tags

  identity {
    type = "SystemAssigned"
  }

  site_config {
    always_on                               = true
    health_check_path                       = "/"
    minimum_tls_version                     = "1.2"
    ftps_state                              = "Disabled"
    vnet_route_all_enabled                  = false
    container_registry_use_managed_identity = true

    application_stack {
      docker_image_name   = "opsbridge-worker:${var.image_tag}"
      docker_registry_url = "https://${var.container_registry}"
    }
  }

  app_settings = merge(local.common_settings, {
    PORT          = "9100"
    WEBSITES_PORT = "9100"
    MONGO_URL     = local.kv_ref["mongo-url"]
  })
}

# ---------- Least-privilege access via Managed Identity (no credentials in app settings) ----------
resource "azurerm_role_assignment" "kv_reader" {
  for_each = {
    api     = azurerm_linux_web_app.api.identity[0].principal_id
    gateway = azurerm_linux_web_app.gateway.identity[0].principal_id
    worker  = azurerm_linux_web_app.worker.identity[0].principal_id
  }
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = each.value
}

# ---------- Monitoring and alerting ----------
resource "azurerm_monitor_diagnostic_setting" "apps" {
  for_each = {
    api     = azurerm_linux_web_app.api.id
    gateway = azurerm_linux_web_app.gateway.id
    worker  = azurerm_linux_web_app.worker.id
  }
  name                       = "to-log-analytics"
  target_resource_id         = each.value
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category = "AppServiceHTTPLogs"
  }
  enabled_log {
    category = "AppServiceConsoleLogs"
  }
  enabled_log {
    category = "AppServicePlatformLogs"
  }
  enabled_metric {
    category = "AllMetrics"
  }
}

resource "azurerm_monitor_action_group" "oncall" {
  name                = "ag-${local.base}-oncall"
  resource_group_name = azurerm_resource_group.main.name
  short_name          = "oncall"

  email_receiver {
    name                    = "oncall"
    email_address           = var.alert_email
    use_common_alert_schema = true
  }
  tags = local.tags
}

resource "azurerm_monitor_metric_alert" "gateway_5xx" {
  name                = "alert-${local.base}-gateway-5xx"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_linux_web_app.gateway.id]
  description         = "More than 10 server errors in 5 minutes at the entry point"
  severity            = 2
  frequency           = "PT1M"
  window_size         = "PT5M"

  criteria {
    metric_namespace = "Microsoft.Web/sites"
    metric_name      = "Http5xx"
    aggregation      = "Total"
    operator         = "GreaterThan"
    threshold        = 10
  }
  action {
    action_group_id = azurerm_monitor_action_group.oncall.id
  }
  tags = local.tags
}

resource "azurerm_monitor_metric_alert" "gateway_latency" {
  name                = "alert-${local.base}-gateway-latency"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_linux_web_app.gateway.id]
  description         = "Average response time above 1.5 s for 5 minutes"
  severity            = 3
  frequency           = "PT1M"
  window_size         = "PT5M"

  criteria {
    metric_namespace = "Microsoft.Web/sites"
    metric_name      = "HttpResponseTime"
    aggregation      = "Average"
    operator         = "GreaterThan"
    threshold        = 1.5
  }
  action {
    action_group_id = azurerm_monitor_action_group.oncall.id
  }
  tags = local.tags
}

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "worker_dlq" {
  name                 = "alert-${local.base}-dead-letters"
  resource_group_name  = azurerm_resource_group.main.name
  location             = azurerm_resource_group.main.location
  scopes               = [azurerm_log_analytics_workspace.main.id]
  evaluation_frequency = "PT5M"
  window_duration      = "PT5M"
  severity             = 2
  description          = "Worker dead-lettered at least one event (poison message or exhausted retries)"

  criteria {
    query                   = "AppServiceConsoleLogs | where ResultDescription has \"event_dead_lettered\""
    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 0
  }
  action {
    action_groups = [azurerm_monitor_action_group.oncall.id]
  }
  tags = local.tags
}

# Pull images with the apps' own identities instead of registry admin credentials.
resource "azurerm_role_assignment" "acr_pull" {
  for_each = var.container_registry_id == null ? {} : {
    api     = azurerm_linux_web_app.api.identity[0].principal_id
    gateway = azurerm_linux_web_app.gateway.identity[0].principal_id
    worker  = azurerm_linux_web_app.worker.identity[0].principal_id
  }
  scope                = var.container_registry_id
  role_definition_name = "AcrPull"
  principal_id         = each.value
}
