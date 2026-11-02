output "gateway_url" {
  value = "https://${azurerm_linux_web_app.gateway.default_hostname}"
}

output "key_vault_name" {
  value = azurerm_key_vault.main.name
}

output "log_analytics_workspace_id" {
  value = azurerm_log_analytics_workspace.main.workspace_id
}

output "web_app_principal_ids" {
  description = "Managed identities of the three apps (granted Key Vault Secrets User, and AcrPull when container_registry_id is set)."
  value = {
    api     = azurerm_linux_web_app.api.identity[0].principal_id
    gateway = azurerm_linux_web_app.gateway.identity[0].principal_id
    worker  = azurerm_linux_web_app.worker.identity[0].principal_id
  }
}
