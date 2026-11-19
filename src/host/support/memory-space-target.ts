import type { MemorySpaceCatalog } from 'dsh-mnemo-weave/source-memory-spaces/contracts'

/**
 * Why a write cannot go to the Memory Space its caller named, before a writer runs (#387):
 * the space is unknown, its Provider is off or takes no writes, or it is switched off and
 * the caller did not ask to switch it on. A model names a space by its description, the
 * judgement that misplaced memories before; switching a space back on is its own request.
 */
export function targetProblem(spaces: MemorySpaceCatalog['items'], target: string, activate: boolean): string | undefined {
  const body = spaces.find(candidate => candidate.id === target)
  if (body === undefined) {
    const known = spaces.slice(0, 20).map(candidate => `${JSON.stringify(candidate.id)} (${candidate.name}${candidate.active ? '' : ', switched off'})`).join(', ')
    return `Memory Space ${JSON.stringify(target)} does not exist. Name one by its id${known === '' ? '; there is none yet.' : `: ${known}.`}`
  }
  if (body.providerEnabled === false) return `Memory Space ${JSON.stringify(target)} uses ${body.provider.label}, which is turned off in the dsh-mnemo-weave settings. Name another space.`
  if (body.provider.capabilities.remember !== true) return `Memory Space ${JSON.stringify(target)} (${body.provider.label}) does not take writes. Name another space.`
  if (!body.active && !activate) {
    return `Memory Space ${JSON.stringify(target)} (${body.name}) is switched off, and a write would switch it back on. Choose an active space or ask the user to reactivate this one.`
  }
  return undefined
}
