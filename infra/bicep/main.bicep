// Bicep twin of the security-critical core of infra/terraform: Key Vault (RBAC), App Service with a
// system-assigned managed identity, secret access via Key Vault reference, and Log Analytics diagnostics.
// Use whichever tool the team standardises on; both express the same governance baseline.
targetScope = 'resourceGroup'

@allowed(['dev', 'prod'])
param environment string
param location string = resourceGroup().location
param namePrefix string = 'opsbridge'
param containerRegistry string
param imageTag string = 'latest'
@secure()
param jwtSecret string

var base = '${namePrefix}-${environment}'
var suffix = take(uniqueString(resourceGroup().id), 5)
var tags = { app: 'opsbridge', environment: environment, managed_by: 'bicep' }

// Built-in role: Key Vault Secrets User
var kvSecretsUserRole = '4633458b-17de-404a-8eee-b4a3e46cdd1e'

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${base}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: environment == 'prod' ? 90 : 30
  }
}

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: take(replace('${namePrefix}${environment}${suffix}', '-', ''), 24)
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 14
    enablePurgeProtection: environment == 'prod' ? true : null
  }
}

resource jwt 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'jwt-secret'
  properties: { value: jwtSecret }
}

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'asp-${base}'
  location: location
  tags: tags
  kind: 'linux'
  sku: { name: environment == 'prod' ? 'P1v3' : 'B1' }
  properties: { reserved: true }
}

resource gateway 'Microsoft.Web/sites@2023-12-01' = {
  name: '${base}-gw-${suffix}'
  location: location
  tags: tags
  kind: 'app,linux,container'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'DOCKER|${containerRegistry}/opsbridge-gateway:${imageTag}'
      alwaysOn: true
      healthCheckPath: '/healthz'
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      acrUseManagedIdentityCreds: true
      appSettings: [
        { name: 'PORT', value: '8080' }
        { name: 'WEBSITES_PORT', value: '8080' }
        { name: 'AUTH_MODE', value: 'local' }
        { name: 'JWT_SECRET', value: '@Microsoft.KeyVault(SecretUri=${jwt.properties.secretUri})' }
      ]
    }
  }
}

resource gatewayKvAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: kv
  name: guid(kv.id, gateway.id, kvSecretsUserRole)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUserRole)
    principalId: gateway.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: gateway
  name: 'to-log-analytics'
  properties: {
    workspaceId: logs.id
    logs: [
      { category: 'AppServiceHTTPLogs', enabled: true }
      { category: 'AppServiceConsoleLogs', enabled: true }
    ]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

output gatewayUrl string = 'https://${gateway.properties.defaultHostName}'
output keyVaultName string = kv.name
