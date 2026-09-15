import { checkForUpdate, type UpdateInfo } from "./desktop";
import { registrarErro } from "./diagnostico";
import { useApp } from "../store/store";

/** Uma consulta/instalacao por vez; cliques repetidos nao substituem o pacote. */
export class SessionUpdates {
  private pending: UpdateInfo | null = null;
  private busy = false;
  private installing = false;
  private destroyed = false;

  private async release(update: UpdateInfo | null) {
    try { await update?.close(); }
    catch (error) { registrarErro("atualizacao:limpeza", error); }
  }

  destroy() {
    this.destroyed = true;
    // A instalacao usa o recurso nativo ate terminar, inclusive em caso de erro.
    if (!this.installing) {
      const update = this.pending;
      this.pending = null;
      void this.release(update);
    }
  }

  async check({ silent = true } = {}) {
    if (this.busy || this.destroyed) return;
    this.busy = true;
    useApp.setState({ updateBusy: true });
    try {
      const update = await checkForUpdate();
      if (this.destroyed) { await this.release(update); return; }
      const previous = this.pending;
      this.pending = update;
      useApp.setState({ updateVersion: update?.version ?? null });
      if (update) useApp.getState().toast("info", `Versao ${update.version} disponivel`);
      else if (!silent) useApp.getState().toast("ok", "Voce ja esta na ultima versao");
      await this.release(previous);
    } catch (error) {
      registrarErro("atualizacao:consulta", error);
      if (!silent && !this.destroyed) useApp.getState().toast("error", "Nao foi possivel consultar atualizacoes. Tente novamente.");
    } finally {
      this.busy = false;
      if (!this.destroyed) useApp.setState({ updateBusy: false });
    }
  }

  async install() {
    if (this.busy || this.destroyed || !this.pending) return;
    this.busy = true;
    this.installing = true;
    const update = this.pending;
    useApp.setState({ updateBusy: true });
    useApp.getState().toast("info", "Baixando atualizacao...");
    try {
      await update.install();
    } catch (error) {
      registrarErro("atualizacao:instalacao", error);
      if (!this.destroyed) useApp.getState().toast("error", "Falha ao atualizar. Tente novamente.");
    } finally {
      this.busy = false;
      this.installing = false;
      if (this.destroyed) {
        this.pending = null;
        await this.release(update);
      } else useApp.setState({ updateBusy: false });
    }
  }
}
