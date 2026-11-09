import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import {
  Callout,
  SectionHeader,
  type ServerConnection,
  ServerConnectionCard,
  type ServerConnectionsClient,
  Skeleton,
} from '@openstuff-dev/ui-angular';
import { Api } from '../../core/api';
import { errorMessage } from '../../core/session';

/** The server package answers `{ error }`; anything else goes through the usual helper. */
function failure(err: unknown): Error {
  if (err instanceof HttpErrorResponse) {
    const body = err.error as { error?: unknown } | null;
    if (typeof body?.error === 'string') return new Error(body.error);
  }
  return new Error(errorMessage(err));
}

/**
 * Integrations, for server admins: this server's connections to OpenVersion and OpenAnnounce.
 * The card from the toolkit does the work; this loads the list.
 */
@Component({
  selector: 'app-settings-integrations',
  imports: [Callout, SectionHeader, ServerConnectionCard, Skeleton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    <header
      os-section-header
      title="Integrations"
      description="Connect other OpenStuff apps. Paste the connection string they give you, and OpenPurpose tests it straight away."
    ></header>
    <hgroup class="server-connections-head">
      <h2>This server</h2>
      <p>Only server admins see these. They apply to everyone on this server.</p>
    </hgroup>
    @if (error(); as error) {
      <os-callout tone="danger" title="The connections didn’t load">{{ error }}</os-callout>
    }
    @if (connections(); as connections) {
      @for (connection of connections; track connection.kind) {
        <os-server-connection-card [connection]="connection" [client]="client" />
      }
    } @else if (!error()) {
      <os-skeleton [lines]="4" />
    }
  `,
  styles: `
    .server-connections-head {
      display: grid;
      gap: var(--os-space-1);
      margin: 0;

      & h2 {
        font-size: var(--os-text-md);
      }

      & p {
        margin: 0;
        color: var(--os-fg-light);
        font-size: var(--os-text-sm);
      }
    }
  `,
})
export class IntegrationsTab {
  private readonly api = inject(Api);
  protected readonly connections = signal<ServerConnection[] | null>(null);
  protected readonly error = signal<string | null>(null);

  protected readonly client: ServerConnectionsClient = {
    save: (kind, body) =>
      this.api.saveServerConnection(kind, body).catch((err: unknown) => {
        throw failure(err);
      }),
    test: (kind) =>
      this.api.testServerConnection(kind).catch((err: unknown) => {
        throw failure(err);
      }),
    remove: async (kind) => {
      await this.api.removeServerConnection(kind).catch((err: unknown) => {
        throw failure(err);
      });
    },
  };

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.connections.set(await this.api.serverConnections());
    } catch (err) {
      this.error.set(failure(err).message);
    }
  }
}
