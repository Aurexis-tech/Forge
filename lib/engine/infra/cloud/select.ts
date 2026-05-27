// CloudProvider factory. Mirror of selectDbProvider / selectProvider.
// The route layer calls selectCloudProvider() to get a CloudProvider
// instance; tests stub THIS module with vi.mock so the route's call
// returns a scripted stub instead of TerraformCliProvider.

import type { CloudProvider, CloudProviderKind } from './provider';
import { TerraformCliProvider } from './terraform-cli';

/**
 * The default kind today — extend the union with new providers
 * (terraform_cloud, pulumi_cli, …) as they're added.
 */
export const DEFAULT_CLOUD_PROVIDER: CloudProviderKind = 'terraform_cli';

export function selectCloudProvider(
  kind: CloudProviderKind = DEFAULT_CLOUD_PROVIDER,
): CloudProvider {
  if (kind === 'terraform_cli') return new TerraformCliProvider();
  // Closed union — unreachable, but defensive.
  throw new Error('unknown CloudProvider kind: ' + String(kind));
}
