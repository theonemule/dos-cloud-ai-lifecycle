targetScope = 'resourceGroup'

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Short naming prefix.')
param prefix string = 'doscloud'

@description('Container image tag pushed to the Azure Container Registry.')
param imageTag string = 'phase5'

@description('Deploy the Container App. Set false on the first pass so ACR exists before the image build.')
param deployApp bool = true

@description('Microsoft Entra tenant ID used by the OIDC app registration.')
param oidcTenantId string

@description('Application (client) ID of the Microsoft Entra app registration.')
param oidcClientId string

@description('Create or update the OIDC client secret in Key Vault during this deployment.')
param manageOidcSecret bool = false

@secure()
@description('Client secret value for the Microsoft Entra app registration. Required only when manageOidcSecret is true.')
param oidcClientSecret string = ''

@description('Display name shown on the login button.')
param oidcProviderName string = 'Microsoft Entra ID'

@description('Leave local password login disabled in a production-style deployment.')
param localAuthEnabled bool = false

@description('Leave local account registration disabled in a production-style deployment.')
param localRegistrationEnabled bool = false

@minValue(1)
@maxValue(1)
@description('SQLite and filesystem state require a single application replica in this design.')
param minReplicas int = 1

@minValue(1)
@maxValue(1)
@description('SQLite and filesystem state require a single application replica in this design.')
param maxReplicas int = 1

@minValue(10)
@description('Persistent Azure Files share quota in GiB.')
param stateShareQuotaGiB int = 100

var suffix = uniqueString(resourceGroup().id)
var environmentName = '${prefix}-env-${suffix}'
var containerAppName = '${prefix}-${suffix}'
var registryName = take(replace('${prefix}${suffix}', '-', ''), 50)
var storageName = take(replace('${prefix}${suffix}state', '-', ''), 24)
var workspaceName = '${prefix}-logs-${suffix}'
var identityName = '${prefix}-identity-${suffix}'
var keyVaultName = take('${prefix}-kv-${suffix}', 24)
var environmentStorageName = 'state'
var fileShareName = 'doscloudstate'
var oidcSecretName = 'oidc-client-secret'
var imageRepository = 'dos-cloud'
var imageName = '${registry.properties.loginServer}/${imageRepository}:${imageTag}'
var appBaseUrl = 'https://${containerAppName}.${environment.properties.defaultDomain}'
var oidcRedirectUri = '${appBaseUrl}/api/auth/oidc/callback'

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: workspaceName
  location: location
  properties: {
    retentionInDays: 30
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

resource environment 'Microsoft.App/managedEnvironments@2026-01-01' = {
  name: environmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: listKeys(logAnalytics.id, '2022-10-01').primarySharedKey
      }
    }
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2025-04-01' = {
  name: registryName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, identity.id, 'acrpull')
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '7f951dda-4ed3-4680-a7ca-43fe172d538d'
    )
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2025-01-01' = {
  name: storageName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true
    publicNetworkAccess: 'Enabled'
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2025-01-01' = {
  parent: storage
  name: 'default'
}

resource stateShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2025-01-01' = {
  parent: fileService
  name: fileShareName
  properties: {
    enabledProtocols: 'SMB'
    shareQuota: stateShareQuotaGiB
  }
}

resource environmentStorage 'Microsoft.App/managedEnvironments/storages@2026-01-01' = {
  parent: environment
  name: environmentStorageName
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: listKeys(storage.id, '2025-01-01').keys[0].value
      shareName: stateShare.name
      accessMode: 'ReadWrite'
    }
  }
}

resource keyVault 'Microsoft.KeyVault/vaults@2025-05-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: tenant().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Enabled'
    sku: {
      family: 'A'
      name: 'standard'
    }
  }
}

resource oidcSecret 'Microsoft.KeyVault/vaults/secrets@2025-05-01' = if (manageOidcSecret) {
  parent: keyVault
  name: oidcSecretName
  properties: {
    value: oidcClientSecret
  }
}

resource keyVaultSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, identity.id, 'key-vault-secrets-user')
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '4633458b-17de-408a-b874-0445c86b69e6'
    )
  }
}

resource containerApp 'Microsoft.App/containerApps@2026-01-01' = if (deployApp) {
  name: containerAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: [
        {
          name: 'oidc-client-secret'
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${oidcSecretName}'
          identity: identity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'dos-cloud'
          image: imageName
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'PORT'
              value: '8080'
            }
            {
              name: 'DOS_CLOUD_STATE_ROOT'
              value: '/data'
            }
            {
              name: 'DOS_CLOUD_HTTPS'
              value: 'false'
            }
            {
              name: 'DOS_CLOUD_SECURE_COOKIES'
              value: 'true'
            }
            {
              name: 'DOS_CLOUD_LOG_TARGET'
              value: 'console'
            }
            {
              name: 'DOS_CLOUD_LOG_FORMAT'
              value: 'json'
            }
            {
              name: 'DOS_CLOUD_LOG_LEVEL'
              value: 'info'
            }
            {
              name: 'DOS_CLOUD_SQLITE_JOURNAL_MODE'
              value: 'DELETE'
            }
            {
              name: 'DOS_CLOUD_SQLITE_BUSY_TIMEOUT_MS'
              value: '10000'
            }
            {
              name: 'DOS_CLOUD_OIDC_ISSUER'
              value: 'https://login.microsoftonline.com/${oidcTenantId}/v2.0'
            }
            {
              name: 'DOS_CLOUD_OIDC_CLIENT_ID'
              value: oidcClientId
            }
            {
              name: 'DOS_CLOUD_OIDC_CLIENT_SECRET'
              secretRef: 'oidc-client-secret'
            }
            {
              name: 'DOS_CLOUD_OIDC_REDIRECT_URI'
              value: oidcRedirectUri
            }
            {
              name: 'DOS_CLOUD_OIDC_PROVIDER_NAME'
              value: oidcProviderName
            }
            {
              name: 'DOS_CLOUD_OIDC_SCOPES'
              value: 'openid profile email'
            }
            {
              name: 'DOS_CLOUD_OIDC_AUTO_PROVISION'
              value: 'true'
            }
            {
              name: 'DOS_CLOUD_LOCAL_AUTH_ENABLED'
              value: string(localAuthEnabled)
            }
            {
              name: 'DOS_CLOUD_LOCAL_REGISTRATION_ENABLED'
              value: string(localRegistrationEnabled)
            }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          volumeMounts: [
            {
              volumeName: 'state'
              mountPath: '/data'
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 10
              periodSeconds: 30
              timeoutSeconds: 5
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/ready'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
      volumes: [
        {
          name: 'state'
          storageType: 'AzureFile'
          storageName: environmentStorage.name
        }
      ]
    }
  }
  dependsOn: [
    acrPull
    keyVaultSecretsUser
    environmentStorage
    oidcSecret
  ]
}

output registryName string = registry.name
output registryLoginServer string = registry.properties.loginServer
output containerImage string = imageName
output containerAppName string = containerAppName
output containerAppUrl string = deployApp ? appBaseUrl : ''
output oidcRedirectUri string = deployApp ? oidcRedirectUri : ''
output stateStorageAccount string = storage.name
output stateFileShare string = stateShare.name
output logAnalyticsWorkspace string = logAnalytics.name
output keyVaultName string = keyVault.name
