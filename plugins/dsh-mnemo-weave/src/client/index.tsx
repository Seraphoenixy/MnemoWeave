/**
 * MnemoWeave DSH plugin — client half.
 *
 * Registers one sidebar entry and the page behind it. Everything the page shows comes
 * from the Host RPC channel, so the browser never holds the Bridge UI token.
 */
import { MAIN_PANEL_ID, type ClientContext } from './dsh-types.ts';
import { MnemoWeaveIcon } from './icon.tsx';
import { MemoryPage } from './page.tsx';
import { ensureStyles } from './styles.ts';

export const name = 'dsh-mnemo-weave';
export const inject = ['slots', 'connection', 'layout'] as const;

const LABEL_ZH = 'MnemoWeave 记忆';
const LABEL_EN = 'MnemoWeave Memory';

function currentLabel(ctx: ClientContext): string {
  const active = ctx.locale?.getSnapshot?.().active;
  return typeof active === 'string' && active.toLowerCase().startsWith('zh') ? LABEL_ZH : LABEL_EN;
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    ensureStyles();
    // A panel declares the main seat first, then its sidebar entry: both are released together.
    return ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', () => {
      const panel = ctx.slots.register({
        name: 'main',
        key: MAIN_PANEL_ID,
        inject: () => ({ connection: ctx.connection, locale: ctx.locale }),
      }, MemoryPage as never);
      let entry: (() => void) | undefined;
      try {
        entry = ctx.slots.register({
          name: 'sidebar.panellist',
          id: MAIN_PANEL_ID,
          order: 40,
          label: () => currentLabel(ctx),
        }, MnemoWeaveIcon as never);
      } catch (error) {
        panel();
        throw error;
      }
      return () => { entry?.(); panel(); };
    }));
  }, 'dsh-mnemo-weave: page');
}
