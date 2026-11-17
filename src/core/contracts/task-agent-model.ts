// The model directory a page may offer as a per-run choice, and the routes a
// Host reports around it. Declared here rather than in the Host protocol so a
// plugin's client may name it without reaching Host-side declarations, which
// would pull a second cordis Context into its standalone typecheck; the Host
// protocol re-exports these so there is still one declaration, not two.

export interface TaskAgentModelCatalogModel {
  id: string
  name: string
  description?: string
  /** DSH's merge-extensible model modality ids; absent means capability is unknown. */
  inputModalities?: string[]
}

export interface TaskAgentModelCatalogGroup {
  id: string
  name: string
  models: TaskAgentModelCatalogModel[]
}

export interface TaskAgentModelCatalogFailure {
  id: string
  name: string
  message: string
}

export interface TaskAgentModelCatalog {
  effective?: { provider: string; model: string; source: 'fixed' | 'session' | 'dsh-default' | 'active-agent' }
  defaultSelection?: { provider: string; model: string }
  /**
   * The route the asking conversation's own delegated work takes while it is
   * open: the model of its last request, or the one it was created with before
   * its first. An inherited setting that follows its conversation takes it too;
   * it is reported whether or not that switch is on.
   */
  session?: { provider: string; model: string }
  /**
   * The route an inherited setting takes without following a conversation: the
   * DSH new-session default, else an open Agent's creation route.
   */
  inherited?: { provider: string; model: string; source: 'dsh-default' | 'active-agent' }
  groups: TaskAgentModelCatalogGroup[]
  failures: TaskAgentModelCatalogFailure[]
}
