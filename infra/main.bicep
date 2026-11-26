@description('Azure region for the Farmer Daily resources.')
param location string = 'westus2'

@description('Short environment name used in resource names.')
@allowed([
  'dev'
  'prod'
])
param environmentName string = 'prod'

var suffix = uniqueString(subscription().subscriptionId, resourceGroup().id)
var staticAppName = 'farmer-daily-${environmentName}-${suffix}'
var cosmosName = 'farmerdaily${environmentName}${suffix}'

resource staticApp 'Microsoft.Web/staticSites@2023-12-01' = {
  name: staticAppName
  location: location
  tags: {
    application: 'Farmer Daily'
    environment: environmentName
    'data-classification': 'confidential-farm-data'
  }
  sku: {
    name: 'Free'
    tier: 'Free'
  }
  properties: {}
}

resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: cosmosName
  location: location
  tags: {
    application: 'Farmer Daily'
    environment: environmentName
    'data-classification': 'confidential-farm-data'
  }
  kind: 'GlobalDocumentDB'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    databaseAccountOfferType: 'Standard'
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
    capabilities: [
      {
        name: 'EnableServerless'
      }
    ]
    minimalTlsVersion: 'Tls12'
    publicNetworkAccess: 'Enabled'
    disableKeyBasedMetadataWriteAccess: true
    enableAutomaticFailover: false
    enableMultipleWriteLocations: false
  }
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15' = {
  parent: cosmos
  name: 'farmer-daily'
  properties: {
    resource: {
      id: 'farmer-daily'
    }
  }
}

resource container 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: database
  name: 'user-state'
  properties: {
    resource: {
      id: 'user-state'
      partitionKey: {
        paths: [
          '/userId'
        ]
        kind: 'Hash'
      }
      defaultTtl: -1
    }
  }
}

output staticAppName string = staticApp.name
output staticAppHostname string = staticApp.properties.defaultHostname
output cosmosAccountName string = cosmos.name
