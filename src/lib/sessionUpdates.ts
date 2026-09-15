import { checkForUpdate } from "./desktop";
import { registrarErro } from "./diagnostico";
import { useApp } from "../store/store";

/** Uma consulta/instalacao por vez; cliques repetidos nao substituem o pacote. */
export class SessionUpdates {
  private pending: (() => Promise<void>) | null = null;
  private busy = false;

  async check({ silent = true } = {}) {
    if (this.busy) return;
    this.busy = true;
    useApp.setState({ updateBusy: true });
    try {
      const update = await checkForUpdate();
      this.pending = update?.install ?? null;
      useApp.setState({ updateVersion: update?.version ?? null });
      if (update) useApp.getState().toast("info", `Versao ${update.version} disponivel`);
      else if (!silent) useApp.getState().toast("ok", "Voce ja esta na ultima versao");
    } catch (error) {
      registrarErro("atualizacao:consulta", error);
      if (!silent) useApp.getState().toast("error", "Nao foi possivel consultar atualizacoes. Tente novamente.");
    } finally {
      this.busy = false;
      useApp.setState({ updateBusy: false });
    }
  }

  async install() {
    if (this.busy || !this.pending) return;
    this.busy = true;
    useApp.setState({ updateBusy: true });
    useApp.getState().toast("info", "Baixando atualizacao...");
    try {
      await this.pending();
    } catch (error) {
      registrarErro("atualizacao:instalacao", error);
      useApp.getState().toast("error", "Falha ao atualizar. Tente novamente.");
    } finally {
      this.busy = false;
      useApp.setState({ updateBusy: false });
    }
  }
}
