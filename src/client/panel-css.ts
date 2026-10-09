/**
 * The panel's stylesheet, rendered by the panel itself as a component-local
 * `<style>` element so unmounting removes it.
 *
 * The rules are copied from the Harness page the panel sits beside — the
 * plugin-management settings section for the list and heading rhythm, the
 * settings-form fields for the control metrics, and the shared primitives for
 * the button, tag and focus behavior — then renamed under the `dshgc-` prefix.
 * Harness Client packages are deliberately NOT imported as modules: only
 * `--dsw-*` theme tokens are shared with the host, so a renamed token degrades
 * appearance instead of blanking the slot entry.
 * @module dsh-git-credentials/client/panel-css
 */

/** Every rule the panel uses, scoped under the `dshgc-` class prefix. */
export const PANEL_CSS = `
.dshgc-section{display:flex;flex-direction:column;gap:12px;max-width:760px;color:var(--dsw-alias-label-primary)}
.dshgc-heading{margin:0;font-size:15px;line-height:22px;font-weight:600}
.dshgc-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.dshgc-status{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-height:28px;font-size:13px;line-height:20px}
.dshgc-muted{color:var(--dsw-alias-label-tertiary)}
.dshgc-ok{color:var(--dsw-alias-state-success-primary)}
.dshgc-error{color:var(--dsw-alias-state-error-primary)}
.dshgc-cards{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.dshgc-empty{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.dshgc-card{display:flex;flex-direction:column;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);padding:12px 14px}
.dshgc-cardHead{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.dshgc-siteId{font-size:14px;line-height:20px;font-weight:600}
.dshgc-facts{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:8px 0 0;font-size:13px;line-height:20px}
.dshgc-facts dt,.dshgc-facts dd{margin:0}
.dshgc-factKey{color:var(--dsw-alias-label-tertiary)}
.dshgc-factValue{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dshgc-actions{display:flex;align-items:center;gap:8px;margin-top:12px}
.dshgc-actionsEnd{justify-content:flex-end}
.dshgc-spacer{flex:1}
.dshgc-divider{border-top:0.5px solid var(--dsw-alias-border-l2)}
.dshgc-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}
.dshgc-field + .dshgc-field{border-top:0.5px solid var(--dsw-alias-border-l2)}
.dshgc-fieldHead{display:flex;align-items:center;gap:8px}
.dshgc-label{flex:1;min-width:0;font-size:13px;line-height:1.5;font-weight:500;color:var(--dsw-alias-label-primary)}
.dshgc-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshgc-invalid{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.dshgc-input,.dshgc-select{box-sizing:border-box;width:100%;height:34px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dshgc-input:focus-visible,.dshgc-select:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.dshgc-input:disabled,.dshgc-select:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.dshgc-input[aria-invalid='true']{border-color:var(--dsw-alias-state-error-primary)}
.dshgc-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);background:transparent;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);cursor:pointer}
.dshgc-button:disabled{cursor:not-allowed;opacity:0.4}
.dshgc-button:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dshgc-buttonPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dshgc-buttonPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dshgc-buttonGhost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshgc-buttonGhost:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.dshgc-buttonSm{height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm);font-size:12px;line-height:18px}
.dshgc-buttonDanger{color:var(--dsw-alias-state-error-primary)}
.dshgc-tag{display:inline-flex;align-items:center;border-radius:999px;padding:1px 8px;border:0.5px solid var(--dsw-alias-border-l4);font-size:11px;line-height:17px;font-weight:500;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.dshgc-tagOk{border-color:transparent;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary)}
.dshgc-tagWarn{border-color:transparent;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary)}
`
