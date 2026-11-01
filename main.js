// ============================================================
// Sistema de Saida de Estoque
// Versao com login (Firebase Authentication) e banco Firestore
// A biblioteca XLSX vem do index.html (variavel global)
// ============================================================
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  createUserWithEmailAndPassword,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  setDoc,
  addDoc,
  deleteDoc,
  updateDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { auth, db, firebaseConfig } from "./firebase-config.js";

// ---------- Estado da aplicacao ----------
const state = {
  view: "registrar",
  user: null, // { uid, nome, email, papel } do usuario logado
  catalog: [], // [{ code, description }]
  records: [], // [{ id, operator, code, description, quantity, orderNumber, createdAt }]
  users: [], // [{ uid, nome, email, papel, ativo }] (so o admin carrega)
  catalogFilter: "",
  historyFilter: "",
  lastLookup: null,
};

let unsubscribers = []; // funcoes para parar de escutar o Firestore
let avisoLogin = ""; // mensagem mostrada na tela de login
let globalClickBound = false;

const app = document.querySelector("#app");

// ---------- Funcoes auxiliares ----------
function isAdmin() {
  return state.user?.papel === "admin";
}

function normalizeCode(value) {
  return String(value ?? "").trim().toUpperCase();
}

// O codigo do item vira o ID do documento. encodeURIComponent evita
// caracteres proibidos em ID (como a barra "/").
function docIdFromCode(code) {
  return encodeURIComponent(code);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

// Data no horario local (AAAA-MM-DD). Corrige o "hoje" virar as 21h.
function localDay(value) {
  return new Date(value).toLocaleDateString("en-CA");
}

function todayCount() {
  const today = localDay(new Date());
  return state.records.filter((record) => localDay(record.createdAt) === today).length;
}

function totalQuantity() {
  return state.records.reduce((sum, record) => sum + Number(record.quantity || 0), 0);
}

function toast(message, type = "success") {
  const region = document.querySelector("#toast-region");
  if (!region) return;
  const item = document.createElement("div");
  item.className = `toast toast-${type}`;
  item.innerHTML = `<span class="toast-mark">${type === "success" ? "✓" : "!"}</span><span>${escapeHtml(message)}</span>`;
  region.append(item);
  window.setTimeout(() => item.remove(), 3600);
}

// ---------- Login ----------
function mensagemErroAuth(error) {
  switch (error?.code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
    case "auth/invalid-email":
      return "E-mail ou senha incorretos.";
    case "auth/too-many-requests":
      return "Muitas tentativas. Aguarde alguns minutos e tente de novo.";
    case "auth/network-request-failed":
      return "Sem conexão com a internet.";
    case "auth/user-disabled":
      return "Esta conta foi desativada.";
    default:
      return "Não foi possível entrar. Tente novamente.";
  }
}

function mostrarMensagemLogin(texto, tipo = "erro") {
  const el = document.querySelector("#login-msg");
  if (!el) return;
  el.textContent = texto;
  el.className = tipo === "ok" ? "login-msg is-ok" : "login-msg";
}

function renderLogin() {
  const aviso = avisoLogin;
  avisoLogin = "";
  app.innerHTML = `
    <div class="login-screen">
      <form class="login-card" id="login-form" novalidate>
        <div class="login-brand"><span class="login-mark">SE</span><div><strong>SAÍDA / ESTOQUE</strong><small>Acesso restrito</small></div></div>
        <h1>Entrar no sistema</h1>
        <p class="login-msg" id="login-msg" role="alert">${escapeHtml(aviso)}</p>
        <label class="field"><span>E-mail</span><input id="login-email" type="email" autocomplete="username" required /></label>
        <label class="field"><span>Senha</span><input id="login-password" type="password" autocomplete="current-password" required /></label>
        <button class="primary-button full" type="submit" id="login-submit">Entrar <span class="button-arrow">→</span></button>
        <button class="text-button login-forgot" type="button" id="login-forgot">Esqueci minha senha</button>
      </form>
    </div>
  `;
  document.querySelector("#login-form").addEventListener("submit", fazerLogin);
  document.querySelector("#login-forgot").addEventListener("click", esqueciSenha);
}

async function fazerLogin(event) {
  event.preventDefault();
  const email = document.querySelector("#login-email").value.trim();
  const senha = document.querySelector("#login-password").value;
  if (!email || !senha) {
    mostrarMensagemLogin("Informe e-mail e senha.");
    return;
  }
  const botao = document.querySelector("#login-submit");
  botao.disabled = true;
  try {
    await signInWithEmailAndPassword(auth, email, senha);
    // Se der certo, o onAuthStateChanged (mais abaixo) abre o sistema.
  } catch (error) {
    mostrarMensagemLogin(mensagemErroAuth(error));
    botao.disabled = false;
  }
}

async function esqueciSenha() {
  const email = document.querySelector("#login-email").value.trim();
  if (!email) {
    mostrarMensagemLogin("Digite seu e-mail no campo acima e clique em “Esqueci minha senha”.");
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
  } catch (error) {
    if (error?.code === "auth/network-request-failed") {
      mostrarMensagemLogin("Sem conexão com a internet.");
      return;
    }
    // Outros erros: mostramos a mesma resposta, para nao revelar quem tem conta.
  }
  mostrarMensagemLogin("Se este e-mail estiver cadastrado, você receberá um link para criar uma nova senha.", "ok");
}

async function sair() {
  await signOut(auth);
}

// ---------- Estrutura da tela (depois do login) ----------
function appShell() {
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand-lockup">
          <div class="brand-mark">SE</div>
          <div>
            <div class="brand-name">SAÍDA</div>
            <div class="brand-subtitle">ESTOQUE</div>
          </div>
        </div>
        <div class="sidebar-divider"></div>
        <p class="sidebar-label">Operação</p>
        <nav class="main-nav" aria-label="Navegação principal">
          <button class="nav-item is-active" data-view="registrar"><span class="nav-icon">＋</span><span>Registrar saída</span></button>
          <button class="nav-item" data-view="historico"><span class="nav-icon">▤</span><span>Histórico</span><span class="nav-count" id="nav-record-count">0</span></button>
          <button class="nav-item" data-view="catalogo"><span class="nav-icon">⌗</span><span>Base de itens</span></button>
          <button class="nav-item" data-view="usuarios" data-admin-only><span class="nav-icon">◎</span><span>Usuários</span></button>
        </nav>
        <div class="sidebar-foot">
          <div class="status-dot"></div>
          <div><strong id="user-name"></strong><small id="user-role"></small></div>
          <button class="logout-button" id="logout-button" type="button">Sair</button>
        </div>
      </aside>

      <main class="main-content">
        <header class="topbar">
          <div>
            <p class="eyebrow">CONTROLE OPERACIONAL / <span id="current-section">REGISTRO</span></p>
            <h1 id="page-title">Registrar saída</h1>
          </div>
          <div class="topbar-actions">
            <div class="live-status"><span class="live-dot"></span> Sistema pronto</div>
            <button class="mobile-menu" id="mobile-menu" aria-label="Abrir menu">☰</button>
          </div>
        </header>

        <section class="view is-visible" data-view-panel="registrar">
          <div class="page-intro">
            <div><p class="section-kicker">NOVA MOVIMENTAÇÃO</p><h2>Registrar saída de material</h2><p class="muted">Informe os dados abaixo. A descrição é preenchida automaticamente pelo código do item.</p></div>
            <div class="shortcut-hint"><span class="keycap">Enter</span> consulta o código</div>
          </div>

          <div class="dashboard-grid">
            <section class="panel form-panel">
              <div class="panel-heading"><div><span class="panel-index">01</span><h3>Dados da saída</h3></div><span class="required-note">* campos obrigatórios</span></div>
              <form id="exit-form" novalidate>
                <div class="form-grid two-columns">
                  <label class="field"><span>Responsável</span><input id="operator" name="operator" readonly /><small>Preenchido automaticamente pelo seu login.</small></label>
                  <label class="field"><span>Nº da ordem <b>*</b></span><input id="order-number" name="orderNumber" maxlength="40" placeholder="Ex.: OS-2026-014" required /></label>
                </div>
                <div class="code-description-row">
                  <label class="field code-field"><span>Código do item <b>*</b></span><div class="input-with-action"><input id="item-code" name="code" placeholder="Ex.: MAT-001" autocomplete="off" required /><button type="button" id="lookup-button" class="lookup-button" title="Consultar código">↵</button></div><small>Digite o código e pressione Enter.</small></label>
                  <label class="field description-field"><span>Descrição <i id="description-status">aguardando código</i></span><input id="item-description" name="description" placeholder="A descrição aparecerá aqui" readonly /></label>
                </div>
                <div class="form-grid quantity-row">
                  <label class="field quantity-field"><span>Quantidade <b>*</b></span><input id="quantity" name="quantity" type="number" min="1" step="1" placeholder="0" required /></label>
                  <div class="form-note"><span class="note-icon">i</span><p>Confira o código e a quantidade antes de registrar. O lançamento ficará disponível no histórico e não poderá ser alterado depois.</p></div>
                </div>
                <div class="form-actions"><button class="secondary-button" type="button" id="clear-form">Limpar campos</button><button class="primary-button" type="submit" id="exit-submit"><span>Registrar saída</span><span class="button-arrow">→</span></button></div>
              </form>
            </section>

            <aside class="side-column">
              <section class="panel metrics-panel"><div class="panel-heading compact"><div><span class="panel-index">02</span><h3>Resumo rápido</h3></div></div><div class="metric-list"><div class="metric"><span>Registros hoje</span><strong id="metric-today">0</strong></div><div class="metric"><span>Itens movimentados</span><strong id="metric-quantity">0</strong></div><div class="metric"><span>Itens no catálogo</span><strong id="metric-catalog">0</strong></div></div></section>
              <section class="tip-card"><div class="tip-tag">COMO USAR</div><h3>Uma etapa por vez.</h3><p>Comece pelo código. Ao encontrar o item, avance para a quantidade e confirme a ordem.</p><div class="tip-line"></div><span>Base pronta para consulta</span></section>
            </aside>
          </div>

          <section class="panel recent-panel"><div class="panel-heading"><div><span class="panel-index">03</span><h3>Últimas saídas</h3></div><button class="text-button" data-view="historico">Ver histórico completo <span>→</span></button></div><div id="recent-records"></div></section>
        </section>

        <section class="view" data-view-panel="historico">
          <div class="page-intro"><div><p class="section-kicker">RASTREABILIDADE</p><h2>Histórico de saídas</h2><p class="muted">Consulte os lançamentos e exporte o relatório quando precisar.</p></div><div class="export-actions"><button class="outline-button" id="export-word">Exportar .doc</button><button class="primary-button small" id="export-excel">Exportar .xlsx <span class="button-arrow">↓</span></button></div></div>
          <section class="panel history-panel"><div class="history-toolbar"><div class="search-box"><span>⌕</span><input id="history-search" placeholder="Buscar por nome, código ou ordem" /></div><span class="result-count" id="history-count">0 registros</span></div><div id="history-table"></div></section>
        </section>

        <section class="view" data-view-panel="catalogo">
          <div class="page-intro"><div><p class="section-kicker">REFERÊNCIA DE MATERIAIS</p><h2>Base de itens</h2><p class="muted" id="catalog-intro"></p></div><div data-admin-only><button class="primary-button small" id="import-trigger">Importar Excel / CSV <span class="button-arrow">↑</span></button><input id="catalog-file" type="file" accept=".xlsx,.xls,.csv" hidden /></div></div>
          <div class="catalog-layout" id="catalog-layout">
            <section class="panel catalog-import-panel" data-admin-only><div class="panel-heading"><div><span class="panel-index">01</span><h3>Adicionar item</h3></div></div><form id="catalog-form"><label class="field"><span>Código do item</span><input id="new-code" placeholder="Ex.: MAT-007" required /></label><label class="field"><span>Descrição do item</span><input id="new-description" placeholder="Ex.: Capacete de proteção" required /></label><button class="primary-button full" type="submit">Salvar item <span class="button-arrow">→</span></button></form><div class="import-help"><strong>Importar planilha</strong><p>A primeira aba deve ter uma coluna de código e outra de descrição. Cabeçalhos como “Código” e “Descrição” são reconhecidos automaticamente.</p></div></section>
            <section class="panel catalog-table-panel"><div class="panel-heading"><div><span class="panel-index">02</span><h3>Itens cadastrados</h3></div><div class="search-box small-search"><span>⌕</span><input id="catalog-search" placeholder="Filtrar itens" /></div></div><div id="catalog-table"></div></section>
          </div>
        </section>

        <section class="view" data-view-panel="usuarios">
          <div class="page-intro"><div><p class="section-kicker">ADMINISTRAÇÃO</p><h2>Usuários</h2><p class="muted">Cadastre quem pode registrar saídas. Só o administrador vê esta tela.</p></div></div>
          <div class="catalog-layout">
            <section class="panel catalog-import-panel"><div class="panel-heading"><div><span class="panel-index">01</span><h3>Novo usuário</h3></div></div>
              <form id="user-form" novalidate>
                <label class="field"><span>Nome (aparece nas saídas)</span><input id="new-user-name" required /></label>
                <label class="field"><span>E-mail</span><input id="new-user-email" type="email" required /></label>
                <label class="field"><span>Senha temporária</span><input id="new-user-password" type="password" autocomplete="new-password" required /><small>Mínimo de 8 caracteres. A pessoa pode trocar usando “Esqueci minha senha”.</small></label>
                <label class="field"><span>Perfil</span><select id="new-user-role"><option value="operador">Operador (só registra saídas)</option><option value="admin">Administrador</option></select></label>
                <button class="primary-button full" type="submit" id="user-submit">Cadastrar usuário <span class="button-arrow">→</span></button>
              </form>
            </section>
            <section class="panel catalog-table-panel"><div class="panel-heading"><div><span class="panel-index">02</span><h3>Usuários cadastrados</h3></div></div><div id="users-table"></div></section>
          </div>
        </section>
      </main>
    </div>
    <div id="toast-region" class="toast-region" aria-live="polite"></div>
  `;
}

// Mostra/esconde o que e so do administrador e preenche o nome no rodape.
// ATENCAO: isso e so visual. A protecao de verdade esta nas regras do Firestore.
function aplicarPermissoes() {
  document.querySelectorAll("[data-admin-only]").forEach((el) => {
    el.hidden = !isAdmin();
  });
  document.querySelector("#catalog-layout").classList.toggle("single-column", !isAdmin());
  document.querySelector("#catalog-intro").textContent = isAdmin()
    ? "Use a planilha existente ou cadastre um item manualmente."
    : "Consulta dos itens disponíveis. Apenas o administrador altera esta base.";
  document.querySelector("#user-name").textContent = state.user.nome;
  document.querySelector("#user-role").textContent = isAdmin() ? "Administrador" : "Operador";
}

// ---------- Renderizacao ----------
function renderStats() {
  const count = document.querySelector("#nav-record-count");
  if (!count) return;
  count.textContent = String(state.records.length);
  document.querySelector("#metric-today").textContent = String(todayCount());
  document.querySelector("#metric-quantity").textContent = String(totalQuantity());
  document.querySelector("#metric-catalog").textContent = String(state.catalog.length);
}

function renderRecent() {
  const target = document.querySelector("#recent-records");
  if (!target) return;
  const records = state.records.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
  if (!records.length) {
    target.innerHTML = `<div class="empty-state"><div class="empty-icon">↗</div><strong>Nenhuma saída registrada ainda</strong><span>Os lançamentos aparecerão aqui depois da confirmação.</span></div>`;
    return;
  }
  target.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Data / hora</th><th>Responsável</th><th>Código</th><th>Descrição</th><th>Qtd.</th><th>Ordem</th></tr></thead><tbody>${records.map(recordRow).join("")}</tbody></table></div>`;
}

function recordRow(record) {
  return `<tr><td class="date-cell">${escapeHtml(formatDate(record.createdAt))}</td><td><strong>${escapeHtml(record.operator)}</strong></td><td><span class="code-chip">${escapeHtml(record.code)}</span></td><td class="description-cell">${escapeHtml(record.description)}</td><td><span class="quantity-chip">${escapeHtml(record.quantity)}</span></td><td>${escapeHtml(record.orderNumber)}</td></tr>`;
}

function renderHistory() {
  const target = document.querySelector("#history-table");
  if (!target) return;
  const term = normalizeCode(state.historyFilter);
  const records = state.records
    .filter((record) => !term || [record.operator, record.code, record.description, record.orderNumber].some((value) => normalizeCode(value).includes(term)))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  document.querySelector("#history-count").textContent = `${records.length} ${records.length === 1 ? "registro" : "registros"}`;
  if (!records.length) {
    target.innerHTML = `<div class="empty-state"><div class="empty-icon">▤</div><strong>${state.records.length ? "Nenhum resultado para esta busca" : "Seu histórico está vazio"}</strong><span>${state.records.length ? "Tente outro termo de busca." : "Registre uma saída para começar a acompanhar as movimentações."}</span></div>`;
    return;
  }
  target.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Data / hora</th><th>Responsável</th><th>Código</th><th>Descrição</th><th>Qtd.</th><th>Nº da ordem</th></tr></thead><tbody>${records.map(recordRow).join("")}</tbody></table></div>`;
}

function renderCatalog() {
  const target = document.querySelector("#catalog-table");
  if (!target) return;
  const term = normalizeCode(state.catalogFilter);
  const items = state.catalog.filter((item) => !term || normalizeCode(item.code).includes(term) || normalizeCode(item.description).includes(term));
  if (!items.length) {
    const dica = isAdmin() ? "Adicione um item ou importe sua planilha." : "Peça ao administrador para cadastrar os itens.";
    target.innerHTML = `<div class="empty-state compact-empty"><strong>Nenhum item encontrado</strong><span>${dica}</span></div>`;
    return;
  }
  const botaoExcluir = (item) => (isAdmin() ? `<td class="align-right"><button class="delete-item" data-delete-code="${escapeHtml(item.code)}" title="Excluir item">×</button></td>` : "<td></td>");
  target.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Código</th><th>Descrição</th><th></th></tr></thead><tbody>${items.map((item) => `<tr><td><span class="code-chip">${escapeHtml(item.code)}</span></td><td class="description-cell">${escapeHtml(item.description)}</td>${botaoExcluir(item)}</tr>`).join("")}</tbody></table></div>`;
}

function renderUsers() {
  const target = document.querySelector("#users-table");
  if (!target) return;
  if (!state.users.length) {
    target.innerHTML = `<div class="empty-state compact-empty"><strong>Nenhum usuário encontrado</strong></div>`;
    return;
  }
  const linhas = state.users
    .map((u) => {
      const ehVoce = u.uid === state.user.uid;
      const acao = ehVoce
        ? `<span class="form-hint">você</span>`
        : `<button class="row-action" data-toggle-user="${escapeHtml(u.uid)}" data-ativo="${u.ativo ? "1" : "0"}">${u.ativo ? "Desativar" : "Reativar"}</button>`;
      return `<tr><td><strong>${escapeHtml(u.nome)}</strong></td><td>${escapeHtml(u.email)}</td><td><span class="role-chip ${u.papel === "admin" ? "is-admin" : ""}">${u.papel === "admin" ? "Administrador" : "Operador"}</span></td><td><span class="state-chip ${u.ativo ? "" : "is-off"}">${u.ativo ? "Ativo" : "Desativado"}</span></td><td class="align-right">${acao}</td></tr>`;
    })
    .join("");
  target.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Situação</th><th></th></tr></thead><tbody>${linhas}</tbody></table></div>`;
}

function switchView(view) {
  if (view === "usuarios" && !isAdmin()) return;
  state.view = view;
  const labels = {
    registrar: ["REGISTRO", "Registrar saída"],
    historico: ["RASTREABILIDADE", "Histórico de saídas"],
    catalogo: ["CATÁLOGO", "Base de itens"],
    usuarios: ["ADMINISTRAÇÃO", "Usuários"],
  };
  document.querySelectorAll("[data-view-panel]").forEach((panel) => panel.classList.toggle("is-visible", panel.dataset.viewPanel === view));
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
  document.querySelector("#current-section").textContent = labels[view][0];
  document.querySelector("#page-title").textContent = labels[view][1];
  document.querySelector(".sidebar").classList.remove("is-open");
  if (view === "historico") renderHistory();
  if (view === "catalogo") renderCatalog();
  if (view === "usuarios") renderUsers();
}

// ---------- Formulario de saida ----------
function resetExitForm() {
  document.querySelector("#exit-form").reset();
  // O reset() apagaria o nome; colocamos de novo o nome do usuario logado.
  document.querySelector("#operator").value = state.user?.nome ?? "";
  const description = document.querySelector("#item-description");
  description.value = "";
  description.className = "";
  document.querySelector("#description-status").textContent = "aguardando código";
  document.querySelector("#description-status").className = "";
  state.lastLookup = null;
}

function lookupCode() {
  const input = document.querySelector("#item-code");
  const code = normalizeCode(input.value);
  const description = document.querySelector("#item-description");
  const status = document.querySelector("#description-status");
  if (!code) {
    description.value = "";
    status.textContent = "informe um código";
    status.className = "status-warn";
    input.focus();
    return;
  }
  const item = state.catalog.find((candidate) => normalizeCode(candidate.code) === code);
  input.value = code;
  state.lastLookup = item ? code : null;
  if (item) {
    description.value = item.description;
    description.className = "found";
    status.textContent = "item localizado";
    status.className = "status-found";
    document.querySelector("#quantity").focus();
  } else {
    description.value = "Código não encontrado na base";
    description.className = "not-found";
    status.textContent = "não localizado";
    status.className = "status-warn";
    input.focus();
    toast("Código não encontrado. Confira a base de itens.", "warning");
  }
}

async function registerExit(event) {
  event.preventDefault();
  const code = normalizeCode(document.querySelector("#item-code").value);
  const quantity = Number(document.querySelector("#quantity").value);
  const orderNumber = document.querySelector("#order-number").value.trim();
  const item = state.catalog.find((candidate) => normalizeCode(candidate.code) === code);
  if (!code || !orderNumber || !Number.isInteger(quantity) || quantity < 1) {
    toast("Preencha todos os campos obrigatórios com valores válidos.", "warning");
    return;
  }
  if (!item) {
    toast("Consulte um código existente antes de registrar.", "warning");
    document.querySelector("#item-code").focus();
    return;
  }
  const botao = document.querySelector("#exit-submit");
  botao.disabled = true;
  try {
    // Os nomes dos campos abaixo precisam bater com as regras do Firestore.
    await addDoc(collection(db, "saidas"), {
      uid: state.user.uid,
      operador: state.user.nome, // vem do cadastro, nao e digitado
      codigo: code,
      descricao: item.description,
      quantidade: quantity,
      ordem: orderNumber,
      criadoEm: serverTimestamp(), // data/hora do servidor
    });
    toast("Saída registrada no histórico.");
    resetExitForm();
    document.querySelector("#item-code").focus();
  } catch (error) {
    console.error(error);
    toast("Não foi possível registrar a saída. Verifique a conexão e tente de novo.", "warning");
  } finally {
    botao.disabled = false;
  }
}

// ---------- Catalogo (so administrador altera) ----------
async function addCatalogItem(event) {
  event.preventDefault();
  if (!isAdmin()) return;
  const codeInput = document.querySelector("#new-code");
  const descriptionInput = document.querySelector("#new-description");
  const code = normalizeCode(codeInput.value);
  const description = descriptionInput.value.trim();
  if (!code || !description) return;
  const existing = state.catalog.some((item) => normalizeCode(item.code) === code);
  try {
    await setDoc(doc(db, "catalogo", docIdFromCode(code)), { codigo: code, descricao: description });
    document.querySelector("#catalog-form").reset();
    toast(existing ? "Item atualizado na base." : "Item adicionado à base.");
  } catch (error) {
    console.error(error);
    toast("Não foi possível salvar o item.", "warning");
  }
}

async function deleteCatalogItem(code) {
  if (!isAdmin()) return;
  if (!window.confirm(`Remover o item ${code} da base?`)) return;
  try {
    await deleteDoc(doc(db, "catalogo", docIdFromCode(code)));
    toast("Item removido da base.");
  } catch (error) {
    console.error(error);
    toast("Não foi possível remover o item.", "warning");
  }
}

function importCatalog(file) {
  if (!file || !isAdmin()) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const workbook = XLSX.read(reader.result, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
      if (!rows.length) throw new Error("A planilha está vazia");
      const first = rows[0].map((value) => normalizeCode(value));
      const codeIndex = first.findIndex((value) => /COD|CÓD|ITEM|MATERIAL/.test(value));
      const descriptionIndex = first.findIndex((value) => /DESCR|NOME|PRODUTO/.test(value));
      const hasHeader = codeIndex >= 0 || descriptionIndex >= 0;
      const codeColumn = codeIndex >= 0 ? codeIndex : 0;
      const descriptionColumn = descriptionIndex >= 0 ? descriptionIndex : 1;
      const start = hasHeader ? 1 : 0;
      const imported = rows
        .slice(start)
        .map((row) => ({ code: normalizeCode(row[codeColumn]), description: String(row[descriptionColumn] ?? "").trim() }))
        .filter((item) => item.code && item.description);
      if (!imported.length) throw new Error("Não encontrei código e descrição nas colunas da planilha");

      // Remove codigos repetidos (vale o ultimo) e grava em lotes de 400
      const unicos = Array.from(new Map(imported.map((item) => [item.code, item])).values());
      toast(`Importando ${unicos.length} item(ns)...`);
      for (let i = 0; i < unicos.length; i += 400) {
        const lote = writeBatch(db);
        unicos.slice(i, i + 400).forEach((item) => {
          lote.set(doc(db, "catalogo", docIdFromCode(item.code)), { codigo: item.code, descricao: item.description });
        });
        await lote.commit();
      }
      toast(`${unicos.length} item(ns) importado(s) com sucesso.`);
    } catch (error) {
      console.error(error);
      toast(error.message || "Não foi possível ler a planilha.", "warning");
    }
  };
  reader.readAsArrayBuffer(file);
}

// ---------- Usuarios (so administrador) ----------
async function createUser(event) {
  event.preventDefault();
  if (!isAdmin()) return;
  const nome = document.querySelector("#new-user-name").value.trim();
  const email = document.querySelector("#new-user-email").value.trim();
  const senha = document.querySelector("#new-user-password").value;
  const papel = document.querySelector("#new-user-role").value === "admin" ? "admin" : "operador";
  if (!nome || !email || senha.length < 8) {
    toast("Informe nome, e-mail e uma senha com pelo menos 8 caracteres.", "warning");
    return;
  }
  const botao = document.querySelector("#user-submit");
  botao.disabled = true;
  // Usamos um segundo "app" do Firebase so para criar a conta,
  // assim o administrador nao e desconectado.
  const appSecundario = initializeApp(firebaseConfig, `cadastro-${Date.now()}`);
  try {
    const authSecundario = getAuth(appSecundario);
    const credencial = await createUserWithEmailAndPassword(authSecundario, email, senha);
    await setDoc(doc(db, "usuarios", credencial.user.uid), { nome, email, papel, ativo: true });
    await signOut(authSecundario);
    document.querySelector("#user-form").reset();
    toast("Usuário cadastrado.");
  } catch (error) {
    console.error(error);
    if (error?.code === "auth/email-already-in-use") {
      toast("Este e-mail já tem conta. Cadastre-o pelo console do Firebase.", "warning");
    } else if (error?.code === "auth/invalid-email") {
      toast("E-mail inválido.", "warning");
    } else if (error?.code === "auth/weak-password") {
      toast("Senha fraca. Use pelo menos 8 caracteres.", "warning");
    } else {
      toast("Não foi possível cadastrar o usuário.", "warning");
    }
  } finally {
    await deleteApp(appSecundario);
    botao.disabled = false;
  }
}

async function toggleUser(uid, ativoAtual) {
  if (!isAdmin() || uid === state.user.uid) return;
  try {
    await updateDoc(doc(db, "usuarios", uid), { ativo: !ativoAtual });
    toast(ativoAtual ? "Usuário desativado." : "Usuário reativado.");
  } catch (error) {
    console.error(error);
    toast("Não foi possível alterar o usuário.", "warning");
  }
}

// ---------- Exportacoes ----------
function exportExcel() {
  if (!state.records.length) {
    toast("Não há registros para exportar.", "warning");
    return;
  }
  const rows = state.records.map((record) => ({ "Data e hora": formatDate(record.createdAt), Responsável: record.operator, Código: record.code, Descrição: record.description, Quantidade: record.quantity, "Nº da ordem": record.orderNumber }));
  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet["!cols"] = [{ wch: 18 }, { wch: 24 }, { wch: 16 }, { wch: 42 }, { wch: 12 }, { wch: 18 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Saídas");
  XLSX.writeFile(workbook, `relatorio-saidas-${localDay(new Date())}.xlsx`);
  toast("Relatório Excel baixado.");
}

function exportWord() {
  if (!state.records.length) {
    toast("Não há registros para exportar.", "warning");
    return;
  }
  const rows = state.records
    .slice()
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .map((record) => `<tr><td>${escapeHtml(formatDate(record.createdAt))}</td><td>${escapeHtml(record.operator)}</td><td>${escapeHtml(record.code)}</td><td>${escapeHtml(record.description)}</td><td>${escapeHtml(record.quantity)}</td><td>${escapeHtml(record.orderNumber)}</td></tr>`)
    .join("");
  const documentHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Relatório de saídas</title><style>body{font-family:Arial,sans-serif;color:#17212b}h1{color:#0b3954}table{border-collapse:collapse;width:100%;font-size:10pt}th{background:#0b3954;color:#fff;text-align:left}td,th{border:1px solid #c9d1d6;padding:7px}</style></head><body><h1>Relatório de saídas</h1><p>Gerado em ${escapeHtml(formatDate(new Date().toISOString()))}</p><table><thead><tr><th>Data e hora</th><th>Responsável</th><th>Código</th><th>Descrição</th><th>Quantidade</th><th>Nº da ordem</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
  const blob = new Blob(["\ufeff", documentHtml], { type: "application/msword" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `relatorio-saidas-${localDay(new Date())}.doc`;
  link.click();
  URL.revokeObjectURL(url);
  toast("Relatório Word baixado.");
}

// ---------- Eventos ----------
function bindEvents() {
  // Clique global: registrado so uma vez (o sistema pode abrir varias vezes)
  if (!globalClickBound) {
    globalClickBound = true;
    document.addEventListener("click", (event) => {
      const viewButton = event.target.closest("[data-view]");
      if (viewButton) switchView(viewButton.dataset.view);
      const deleteButton = event.target.closest("[data-delete-code]");
      if (deleteButton) deleteCatalogItem(normalizeCode(deleteButton.dataset.deleteCode));
      const toggleButton = event.target.closest("[data-toggle-user]");
      if (toggleButton) toggleUser(toggleButton.dataset.toggleUser, toggleButton.dataset.ativo === "1");
    });
  }
  document.querySelector("#exit-form").addEventListener("submit", registerExit);
  document.querySelector("#item-code").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      lookupCode();
    }
  });
  document.querySelector("#lookup-button").addEventListener("click", lookupCode);
  document.querySelector("#clear-form").addEventListener("click", resetExitForm);
  document.querySelector("#catalog-form").addEventListener("submit", addCatalogItem);
  document.querySelector("#import-trigger").addEventListener("click", () => document.querySelector("#catalog-file").click());
  document.querySelector("#catalog-file").addEventListener("change", (event) => {
    importCatalog(event.target.files[0]);
    event.target.value = "";
  });
  document.querySelector("#user-form").addEventListener("submit", createUser);
  document.querySelector("#export-excel").addEventListener("click", exportExcel);
  document.querySelector("#export-word").addEventListener("click", exportWord);
  document.querySelector("#logout-button").addEventListener("click", sair);
  document.querySelector("#history-search").addEventListener("input", (event) => {
    state.historyFilter = event.target.value;
    renderHistory();
  });
  document.querySelector("#catalog-search").addEventListener("input", (event) => {
    state.catalogFilter = event.target.value;
    renderCatalog();
  });
  document.querySelector("#mobile-menu").addEventListener("click", () => document.querySelector(".sidebar").classList.toggle("is-open"));
}

// ---------- Dados em tempo real (Firestore) ----------
function pararListeners() {
  unsubscribers.forEach((parar) => parar());
  unsubscribers = [];
}

function erroListener(error) {
  console.error(error);
  toast(`Não foi possível carregar os dados (${error.code || "erro"}).`, "warning");
}

function iniciarListeners() {
  // Catalogo de itens
  unsubscribers.push(
    onSnapshot(
      collection(db, "catalogo"),
      (snap) => {
        state.catalog = snap.docs
          .map((d) => ({ code: d.data().codigo, description: d.data().descricao }))
          .filter((item) => item.code)
          .sort((a, b) => a.code.localeCompare(b.code, "pt-BR"));
        renderStats();
        if (state.view === "catalogo") renderCatalog();
      },
      erroListener,
    ),
  );

  // Saidas registradas (mais recentes primeiro)
  unsubscribers.push(
    onSnapshot(
      query(collection(db, "saidas"), orderBy("criadoEm", "desc")),
      (snap) => {
        state.records = snap.docs.map((d) => {
          const x = d.data({ serverTimestamps: "estimate" });
          return {
            id: d.id,
            operator: x.operador,
            code: x.codigo,
            description: x.descricao,
            quantity: x.quantidade,
            orderNumber: x.ordem,
            createdAt: x.criadoEm ? x.criadoEm.toDate().toISOString() : new Date().toISOString(),
          };
        });
        renderStats();
        renderRecent();
        renderHistory();
      },
      erroListener,
    ),
  );

  // Lista de usuarios (so o administrador carrega)
  if (isAdmin()) {
    unsubscribers.push(
      onSnapshot(
        collection(db, "usuarios"),
        (snap) => {
          state.users = snap.docs
            .map((d) => ({ uid: d.id, ...d.data() }))
            .sort((a, b) => String(a.nome).localeCompare(String(b.nome), "pt-BR"));
          renderUsers();
        },
        erroListener,
      ),
    );
  }
}

// ---------- Inicio: quem esta logado? ----------
app.innerHTML = `<p class="boot-msg">Carregando...</p>`;

onAuthStateChanged(auth, async (firebaseUser) => {
  pararListeners();
  state.user = null;
  state.catalog = [];
  state.records = [];
  state.users = [];
  state.view = "registrar";

  // Ninguem logado: mostra a tela de login
  if (!firebaseUser) {
    renderLogin();
    return;
  }

  try {
    // Confere se a pessoa esta cadastrada e ativa em /usuarios/{uid}
    const snap = await getDoc(doc(db, "usuarios", firebaseUser.uid));
    const dados = snap.exists() ? snap.data() : null;
    if (!dados || dados.ativo !== true || !dados.nome) {
      avisoLogin = "Seu acesso não está liberado. Fale com o administrador.";
      await signOut(auth); // dispara este bloco de novo e abre o login
      return;
    }
    state.user = {
      uid: firebaseUser.uid,
      nome: dados.nome,
      email: dados.email || firebaseUser.email,
      papel: dados.papel === "admin" ? "admin" : "operador",
    };
  } catch (error) {
    console.error(error);
    avisoLogin = "Não foi possível verificar seu acesso. Tente novamente.";
    await signOut(auth);
    return;
  }

  // Abre o sistema
  appShell();
  aplicarPermissoes();
  bindEvents();
  resetExitForm();
  iniciarListeners();
  renderStats();
  renderRecent();
});
