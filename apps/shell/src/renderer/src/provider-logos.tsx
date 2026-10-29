import { ProviderLogo as SharedProviderLogo } from '@vantage/ui'

export function ProviderLogo({ id }: { id: string }) {
  return <SharedProviderLogo id={id} className="set-provider-logo" />
}
