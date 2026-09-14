/**
 * Connection and permission diagnostics.
 *
 * Rendered in two places, from one definition: on the not-connected screen,
 * where it answers "why can't this see my org", and on the Overview, where it
 * answers a different question — "will the checks that depend on a permission
 * actually run here, and what will they cost".
 *
 * It is a button rather than something that runs on load. Each probe is one API
 * call against the org's daily allowance, and this tool does not spend that
 * without being asked.
 */

import { html, nothing, type TemplateResult } from 'lit';
import { store } from '../state';

export function renderDiagnostics(options: { blurb: string }): TemplateResult {
  const { diagnostics, diagnosing } = store.state;

  return html`
    <div class="os-card">
      <div class="os-card__header">
        <h2 class="os-card__title">Connection and permissions</h2>
        <span class="os-metric__sub">${options.blurb}</span>
      </div>
      <div class="os-card__body os-stack">
        <div class="os-toolbar" style="padding:0;border:0">
          <button
            class="os-button"
            type="button"
            ?disabled=${diagnosing}
            title="Runs about ten single-row queries against the org. Nothing is scanned and no report is run."
            @click=${() => void store.runDiagnostics()}
          >
            ${diagnosing ? 'Running diagnostics…' : 'Run diagnostics'}
          </button>
          <span class="os-metric__sub">
            About ten single-row queries. No scan, and no report is executed.
          </span>
        </div>

        ${diagnostics
          ? html`<div class="os-table-wrap">
              <table class="os-table">
                <thead>
                  <tr>
                    <th scope="col" style="width:38%">Step</th>
                    <th scope="col">Result</th>
                  </tr>
                </thead>
                <tbody>
                  ${diagnostics.map(
                    (check) => html`
                      <tr>
                        <td
                          class="os-sev-rail os-sev-rail--${check.ok ? 'success' : 'critical'}"
                          title=${check.name}
                        >
                          ${check.name}
                        </td>
                        <td title=${check.detail}>
                          ${check.ok
                            ? check.detail
                            : html`<span style="color:var(--os-status-critical)"
                                >${check.detail}</span
                              >`}
                        </td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            </div>`
          : nothing}
      </div>
    </div>
  `;
}
