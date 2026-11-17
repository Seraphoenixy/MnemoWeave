import { css, useT } from './presentation.ts'
import type { JSX } from 'react'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { NATIVE_PROVIDER_ID, type MemoryPlacementCapability, type MemoryPlacementPreference, type MemoryProviderDescriptor, type MemoryProviderId, type MemoryPersistenceStrategy } from '../contracts.ts'
import type { MemorySpacesPageClient } from './api.ts'
import { ProviderIcon } from './ProviderIcon.tsx'
import { providerSummary } from './provider-presentation.ts'
import { appearanceClass, message, SectionSpinner, SidebarModal, SelectField, TaskAgentTag } from 'dsh-mnemo-weave/client'
import { ProviderMemoryFields, mergeProviderDefaults, providerDraftComplete, providerUnavailableKey, readyFirst, readyProviderId, type ProviderDrafts } from './widgets.tsx'

export interface MemoryPlacementSettings { setPath(path: string[], value: unknown): Promise<void> }
export interface MemoryPlacementPageConfig { persistenceStrategy?: MemoryPersistenceStrategy }

type MemoryPlacementMode = 'manual' | 'automatic'

export function PersistenceStrategyDialog(props: {
  client: MemorySpacesPageClient
  settingsScope: MemoryPlacementSettings
  config: MemoryPlacementPageConfig | undefined
  writable: boolean
  agentAvailable: boolean
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const strategyFormId = useId()
  const configured = props.config?.persistenceStrategy
  const [mode, setMode] = useState<MemoryPlacementMode>(configured?.mode ?? 'manual')
  const [providerId, setProviderId] = useState<MemoryProviderId>(configured?.providerId ?? NATIVE_PROVIDER_ID)
  const [prompt, setPrompt] = useState(configured?.prompt ?? '')
  const [dataBoundary, setDataBoundary] = useState<'allow-remote' | 'local-only'>(configured?.rules?.dataBoundary ?? 'allow-remote')
  const [preference, setPreference] = useState<MemoryPlacementPreference>(configured?.rules?.preference ?? 'balanced')
  const [requiredCapabilities, setRequiredCapabilities] = useState<MemoryPlacementCapability[]>(configured?.rules?.requiredCapabilities ?? [])
  const [automaticProviderIds, setAutomaticProviderIds] = useState<MemoryProviderId[]>(configured?.rules?.allowedProviderIds ?? [NATIVE_PROVIDER_ID])
  const [providerDrafts, setProviderDrafts] = useState<ProviderDrafts>(configured?.providerConnections ?? {})
  const [providers, setProviders] = useState<MemoryProviderDescriptor[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    void props.client.bodyDirectory().then(catalog => {
      if (!current) return
      const next = catalog.providers
      setProviders(next)
      setProviderDrafts(previous => mergeProviderDefaults(next, previous))
      setProviderId(currentProviderId => readyProviderId(next, currentProviderId) ?? currentProviderId)
      // Without a saved candidate list, start from the provider that is ready now.
      if (configured?.rules?.allowedProviderIds === undefined) {
        setAutomaticProviderIds(current => {
          const ready = current.filter(id => next.some(provider => provider.id === id && provider.serviceConfigured !== false))
          const first = readyProviderId(next)
          return ready.length > 0 || first === undefined ? ready : [first]
        })
      }
    }).catch(reason => { if (current) setError(message(reason)) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [props.client])

  const selectedProvider = providers.find(provider => provider.id === providerId)
  const selectedAutomaticProviders = automaticProviderIds.map(id => providers.find(provider => provider.id === id)).filter((provider): provider is MemoryProviderDescriptor => provider !== undefined)
  const selectedProvidersValid = mode === 'manual'
    ? providerDraftComplete(selectedProvider, providerDrafts[providerId])
    : automaticProviderIds.length > 0 && selectedAutomaticProviders.length === automaticProviderIds.length && selectedAutomaticProviders.every(provider => providerDraftComplete(provider, providerDrafts[provider.id]))
  const updateDraft = (id: MemoryProviderId, key: string, value: string | number | boolean) => setProviderDrafts(current => ({ ...current, [id]: { ...(current[id] ?? {}), [key]: value } }))
  const toggleCapability = (capability: MemoryPlacementCapability) => setRequiredCapabilities(current => current.includes(capability) ? current.filter(value => value !== capability) : [...current, capability])
  const toggleProvider = (id: MemoryProviderId, selected: boolean) => setAutomaticProviderIds(current => selected ? [...new Set([...current, id])] : current.filter(value => value !== id))

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (loading || saving || !props.writable || !selectedProvidersValid) return
    const selectedIds = mode === 'manual' ? [providerId] : automaticProviderIds
    const connections = Object.fromEntries(selectedIds.filter(id => providers.find(provider => provider.id === id)?.origin !== 'native').map(id => [id, providerDrafts[id] ?? {}])) as ProviderDrafts
    setSaving(true); setError(null)
    try {
      await props.settingsScope.setPath(['persistenceStrategy'], {
        mode,
        providerId,
        prompt,
        rules: {
          allowedProviderIds: automaticProviderIds,
          dataBoundary,
          requiredCapabilities,
          preference,
        },
        providerConnections: connections,
      })
      props.onClose()
    } catch (reason) { setError(message(reason)) } finally { setSaving(false) }
  }

  return <SidebarModal title={t('strategy.title')} description={t('strategy.description')} busy={saving} contentReady={!loading} wide onClose={props.onClose} footer={<div className={css.modalFooterActions}><button type="button" data-dialog-close className={css.secondaryButton} disabled={saving} onClick={props.onClose}>{t('common.cancel')}</button><button type="submit" form={strategyFormId} className={css.primaryButton} disabled={loading || saving || !props.writable || !selectedProvidersValid}>{saving ? t('strategy.saving') : t('strategy.save')}</button></div>}>
    <form id={strategyFormId} className={appearanceClass(css.bodyEdit, css.strategyForm)} onSubmit={event => void save(event)}>
      {loading && <div className={css.strategyLoading}><SectionSpinner label={t('strategy.loading')} /><span>{t('strategy.loading')}</span></div>}
      {error !== null && <div className={css.inlineError} role="alert">{error}</div>}
      {!loading && <>
        <section className={css.createSection}>
          <div className={css.createSectionHeading}><span>01</span><div><strong>{t('strategy.modeTitle')}</strong><small>{t('strategy.modeHint')}</small></div></div>
          <fieldset className={css.placementMode}><legend>{t('overview.placementMode')}</legend>
            <label data-selected={mode === 'manual' || undefined}><input type="radio" name="persistence-mode" value="manual" checked={mode === 'manual'} data-autofocus={mode === 'manual' || undefined} onChange={() => setMode('manual')} /><i className={css.choiceControl} data-kind="radio" aria-hidden="true" /><span><strong>{t('overview.placementManual')}</strong><small>{t('strategy.manualHint')}</small></span></label>
            <label data-selected={mode === 'automatic' || undefined}><input type="radio" name="persistence-mode" value="automatic" checked={mode === 'automatic'} data-autofocus={mode === 'automatic' || undefined} onChange={() => setMode('automatic')} /><i className={css.choiceControl} data-kind="radio" aria-hidden="true" /><span><strong>{t('overview.placementAutomatic')} <em>{t('overview.recommended')}</em></strong><small>{t('strategy.automaticHint')}</small></span></label>
          </fieldset>
        </section>
        <section className={css.createSection}>
          <div className={css.createSectionHeading}><span>02</span><div><strong>{t(mode === 'manual' ? 'strategy.manualTitle' : 'strategy.automaticTitle')}</strong><small>{t(mode === 'manual' ? 'strategy.manualDescription' : 'strategy.automaticDescription')}</small></div></div>
          {mode === 'manual' ? <>
            <fieldset className={css.providerChoice}><legend>{t('overview.providerLabel')}</legend>{readyFirst(providers).map(provider => {
              const disabled = provider.serviceConfigured === false
              return <label key={provider.id} data-selected={providerId === provider.id || undefined} data-native={provider.origin === 'native' || undefined} data-disabled={disabled || undefined}>
                <input type="radio" name="strategy-provider" value={provider.id} checked={providerId === provider.id} disabled={disabled} onChange={() => setProviderId(provider.id)} />
                <ProviderIcon providerId={provider.id} icon={provider.icon} className={css.providerChoiceIcon} />
                <span><strong>{provider.label}{provider.origin === 'native' && <em>{t('overview.nativeOfficial')}</em>}</strong><small>{disabled ? t(providerUnavailableKey(provider)) : `${t(`overview.workspaceBinding.${provider.workspaceBinding}`)} · ${providerSummary(t, provider)}`}</small></span>
                <i className={css.choiceControl} data-kind="radio" aria-hidden="true" />
              </label>
            })}</fieldset>
            {selectedProvider !== undefined && selectedProvider.origin !== 'native' && <ProviderMemoryFields provider={selectedProvider} connection={providerDrafts[selectedProvider.id] ?? {}} onChange={(key, value) => updateDraft(selectedProvider.id, key, value)} />}
          </> : <section className={css.placementPolicy} aria-label={t('overview.placementPolicy')}>
            <div className={css.placementPolicyHeading}><div><strong>{t('overview.placementPolicy')}</strong><small>{t('overview.placementPolicyHint')}</small></div><TaskAgentTag available={props.agentAvailable} /></div>
            <label>{t('overview.placementPrompt')}<textarea aria-label={t('overview.placementPrompt')} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={t('overview.placementPromptPlaceholder')} rows={3} maxLength={4000} /></label>
            <div className={css.placementRuleGrid}><SelectField label={t('overview.dataBoundary')} value={dataBoundary} options={[{ value: 'allow-remote', label: t('overview.dataBoundaryRemote') }, { value: 'local-only', label: t('overview.dataBoundaryLocal') }]} onChange={value => { setDataBoundary(value); if (value === 'local-only') setAutomaticProviderIds(current => current.filter(id => providers.find(provider => provider.id === id)?.kind === 'local')) }} /><SelectField label={t('overview.preference')} value={preference} options={[{ value: 'balanced', label: t('overview.preferenceBalanced') }, { value: 'local-first', label: t('overview.preferenceLocal') }, { value: 'shared-first', label: t('overview.preferenceShared') }]} onChange={setPreference} /></div>
            <fieldset className={css.capabilityRules}><legend>{t('overview.requiredCapabilities')}</legend>{(['graph', 'exact-write', 'forget'] as const).map(capability => {
              const selected = requiredCapabilities.includes(capability)
              return <label key={capability} data-selected={selected || undefined}><input type="checkbox" checked={selected} onChange={() => toggleCapability(capability)} /><i className={css.choiceControl} data-kind="check" aria-hidden="true" /><span>{t(`overview.capability.${capability}`)}</span></label>
            })}</fieldset>
            <div className={css.placementCandidates}>{readyFirst(providers).map(provider => {
              const selected = automaticProviderIds.includes(provider.id)
              // A saved candidate that is no longer ready can still be cleared.
              const disabled = (provider.serviceConfigured === false && !selected) || (dataBoundary === 'local-only' && provider.kind === 'remote')
              return <label key={provider.id} data-selected={selected || undefined} data-disabled={disabled || undefined}><input type="checkbox" checked={selected} disabled={disabled} onChange={event => toggleProvider(provider.id, event.target.checked)} /><ProviderIcon providerId={provider.id} icon={provider.icon} className={css.candidateIcon} /><span><strong>{provider.label}</strong><small>{provider.serviceConfigured === false ? t(providerUnavailableKey(provider)) : provider.origin === 'native' ? t('overview.candidateNativeReady') : provider.kind === 'local' ? t('overview.candidateLocal') : t('overview.candidateRemote')}</small></span><i className={css.choiceControl} data-kind="check" aria-hidden="true" /></label>
            })}</div>
            {automaticProviderIds.map(id => { const provider = providers.find(candidate => candidate.id === id); return provider === undefined || provider.origin === 'native' ? null : <ProviderMemoryFields key={id} provider={provider} connection={providerDrafts[id] ?? {}} onChange={(key, value) => updateDraft(id, key, value)} /> })}
          </section>}
        </section>
      </>}
    </form>
  </SidebarModal>
}
