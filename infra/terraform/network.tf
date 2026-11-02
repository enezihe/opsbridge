# ---------- Network: one VNet, one subnet for app egress, one for private endpoints ----------
resource "azurerm_virtual_network" "main" {
  name                = "vnet-${local.base}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  address_space       = [var.vnet_address_space]
  tags                = local.tags
}

resource "azurerm_subnet" "integration" {
  name                 = "snet-integration"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [cidrsubnet(var.vnet_address_space, 8, 1)] # 10.20.1.0/24

  delegation {
    name = "app-service"
    service_delegation {
      name    = "Microsoft.Web/serverFarms"
      actions = ["Microsoft.Network/virtualNetworks/subnets/action"]
    }
  }
}

resource "azurerm_subnet" "private_endpoints" {
  name                              = "snet-private-endpoints"
  resource_group_name               = azurerm_resource_group.main.name
  virtual_network_name              = azurerm_virtual_network.main.name
  address_prefixes                  = [cidrsubnet(var.vnet_address_space, 8, 2)] # 10.20.2.0/24
  private_endpoint_network_policies = "Enabled"
}
# ---------- NSG: private endpoint subnet accepts only app traffic on the service ports ----------
resource "azurerm_network_security_group" "private_endpoints" {
  name                = "nsg-${local.base}-pe"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags

  security_rule {
    name                       = "allow-app-to-services"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_ranges    = ["443", "10255", "9093"]
    source_address_prefix      = azurerm_subnet.integration.address_prefixes[0]
    destination_address_prefix = azurerm_subnet.private_endpoints.address_prefixes[0]
  }

  security_rule {
    name                       = "deny-all-inbound"
    priority                   = 4096
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "private_endpoints" {
  subnet_id                 = azurerm_subnet.private_endpoints.id
  network_security_group_id = azurerm_network_security_group.private_endpoints.id
}

# ---------- Private DNS: resolve the service names to the private endpoint IPs inside the VNet ----------
locals {
  private_dns_zones = {
    keyvault = "privatelink.vaultcore.azure.net"
    cosmos   = "privatelink.mongo.cosmos.azure.com"
    eventhub = "privatelink.servicebus.windows.net"
  }
}

resource "azurerm_private_dns_zone" "main" {
  for_each            = local.private_dns_zones
  name                = each.value
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "main" {
  for_each              = local.private_dns_zones
  name                  = "link-${each.key}"
  resource_group_name   = azurerm_resource_group.main.name
  private_dns_zone_name = azurerm_private_dns_zone.main[each.key].name
  virtual_network_id    = azurerm_virtual_network.main.id
}

# ---------- Private endpoints: Key Vault, Cosmos DB and Event Hubs get a private IP in the VNet ----------
locals {
  private_endpoints = {
    keyvault = {
      resource_id = azurerm_key_vault.main.id
      subresource = "vault"
    }
    cosmos = {
      resource_id = azurerm_cosmosdb_account.main.id
      subresource = "MongoDB"
    }
    eventhub = {
      resource_id = azurerm_eventhub_namespace.main.id
      subresource = "namespace"
    }
  }
}

resource "azurerm_private_endpoint" "main" {
  for_each            = local.private_endpoints
  name                = "pe-${local.base}-${each.key}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  subnet_id           = azurerm_subnet.private_endpoints.id
  tags                = local.tags

  private_service_connection {
    name                           = "psc-${each.key}"
    private_connection_resource_id = each.value.resource_id
    subresource_names              = [each.value.subresource]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "default"
    private_dns_zone_ids = [azurerm_private_dns_zone.main[each.key].id]
  }
}