/**
 * MnemoWeave DSH plugin — client half.
 *
 * Registers one sidebar entry and the page behind it. Everything the page shows comes
 * from the Host RPC channel, so the browser never holds the MnemoWeave service token.
 */
import { MAIN_PANEL_ID, type ClientContext, type LocaleService } from './dsh-types.ts';
import { MnemoWeaveIcon } from './icon.tsx';
import { MemoryPage } from './page.tsx';
import { ensureStyles } from './styles.ts';

export const name = 'dsh-mnemo-weave';
export const inject = ['slots', 'connection', 'layout', 'locale'] as const;

// Sidebar entries are narrow: the Chinese label is kept to four characters.
const LABEL_ZH = '记忆中枢';
const LABEL_EN = 'MnemoWeave Memory';

/** Reading a service the plugin did not inject throws in the client tree; this answers undefined instead. */
function readLocale(ctx: ClientContext): LocaleService | undefined {
  try {
    return ctx.locale;
  } catch {
    return undefined;
  }
}

function readActiveLocale(ctx: ClientContext): string | undefined {
  try {
    const active = readLocale(ctx)?.getSnapshot?.().active;
    return typeof active === 'string' && active !== '' ? active : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The sidebar derives panel metadata at registration and again on every locale change, so this label
 * runs inside the sidebar's locale subscriber: an exception here aborts the sidebar entry and fails
 * the whole web boot. Both reads above therefore answer with a fallback instead of throwing.
 */
function currentLabel(ctx: ClientContext): string {
  const active = readActiveLocale(ctx);
  return active !== undefined && active.toLowerCase().startsWith('zh') ? LABEL_ZH : LABEL_EN;
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    ensureStyles();
    // A panel declares the main seat first, then its sidebar entry: both are released together.
    return ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', () => {
      const panel = ctx.slots.register({
        name: 'main',
        key: MAIN_PANEL_ID,
        inject: () => ({ connection: ctx.connection, locale: readLocale(ctx) }),
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
