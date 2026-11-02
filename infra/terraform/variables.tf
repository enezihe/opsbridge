variable "environment" {
  type        = string
  description = "dev | prod"
  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be dev or prod."
  }
}

variable "location" {
  type    = string
  default = "canadacentral"
}

variable "name_prefix" {
  type    = string
  default = "opsbridge"
}

variable "image_tag" {
  type        = string
  description = "Container image tag deployed to the web apps (git SHA from the pipeline)."
  default     = "latest"
}

variable "container_registry" {
  type        = string
  description = "Registry host holding the opsbridge-* images, e.g. myacr.azurecr.io"
}

variable "app_service_sku" {
  type    = string
  default = "B1"
}

variable "alert_email" {
  type        = string
  description = "Receives 5xx and availability alerts."
}

variable "extra_tags" {
  type    = map(string)
  default = {}
}

variable "container_registry_id" {
  type        = string
  description = "Resource ID of the registry; when set, the web app identities are granted AcrPull on it."
  default     = null
}

variable "vnet_address_space" {
  type        = string
  description = "Address space of the application VNet."
  default     = "10.20.0.0/16"
}

variable "private_only" {
  type        = bool
  description = "Disable public network access on Key Vault, Cosmos DB and Event Hubs. Requires the deployer to reach the VNet (self-hosted runner or VPN) because Terraform writes Key Vault secrets."
  default     = false
}