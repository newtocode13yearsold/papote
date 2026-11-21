// Papote — chat entre amis.
// Firebase Auth = les comptes (email + mot de passe)
// Firestore     = la base de données en temps réel (pseudos, amis, messages)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut, sendPasswordResetEmail,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, deleteDoc, collection, query, where,
  orderBy, limit, limitToLast, onSnapshot, writeBatch, serverTimestamp, updateDoc, deleteField,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';
import {
  getStorage, ref as fileRef, uploadBytesResumable, getDownloadURL,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-storage.js';
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
auth.languageCode = 'fr';
const db = getFirestore(app);
const storage = getStorage(app); // Firebase Storage = les photos, vidéos et fichiers envoyés

const $ = (id) => document.getElementById(id);
const USERNAME_RE = /^[A-Za-z0-9_.]{3,20}$/;

let me = null;          // { uid, username }
let chats = [];         // mes conversations (amis + demandes)
let openChatId = null;  // conversation ouverte
let people = [];        // tous les membres inscrits (sauf moi)
let unsubChats = null;
let unsubPeople = null;
let unsubMessages = null;

// ---------- Petits outils ----------
function show(screen) {
  for (const id of ['loading', 'authScreen', 'pickScreen', 'app']) $(id).hidden = id !== screen;
}

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
}

function setMsg(el, text, ok = false) {
  el.textContent = text || '';
  el.classList.toggle('ok', ok);
}

// Couleur d'avatar stable, calculée à partir du pseudo
function colorFor(name) {
  let h = 0;
  for (const c of name || '') h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 65% 52%)`;
}
function paintAvatar(el, name) {
  el.textContent = (name || '?').charAt(0);
  el.style.background = colorFor(name);
}

function toDate(ts) { return ts?.toDate ? ts.toDate() : new Date(); }
function hhmm(d) { return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
function dayLabel(d) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const diff = Math.round((today - that) / 86400000);
  if (diff === 0) return "Aujourd'hui";
  if (diff === 1) return 'Hier';
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}
function shortTime(d) {
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? hhmm(d)
    : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

function friendlyError(err) {
  const code = err?.code || '';
  const map = {
    'auth/email-already-in-use': 'Cet email a déjà un compte. Connecte-toi plutôt.',
    'auth/invalid-email': "Cet email n'est pas valide.",
    'auth/weak-password': 'Mot de passe trop court (6 caractères minimum).',
    'auth/invalid-credential': 'Email ou mot de passe incorrect.',
    'auth/wrong-password': 'Email ou mot de passe incorrect.',
    'auth/user-not-found': 'Email ou mot de passe incorrect.',
    'auth/too-many-requests': 'Trop d’essais. Réessaie dans quelques minutes.',
    'auth/network-request-failed': 'Pas de connexion internet.',
    'permission-denied': "Action refusée. Ce pseudo est peut-être déjà pris.",
  };
  return map[code] || 'Oups, une erreur est survenue. Réessaie.';
}

// "Lu jusqu'à" : gardé dans ce navigateur, et aussi dans la conversation
// (chats/{id}.reads.{uid}) pour que ton ami voie que tu as lu ses messages
function readMs(chat, uid) {
  const t = chat?.reads?.[uid];
  return t?.toDate ? t.toDate().getTime() : 0;
}
function lastRead(chatId) {
  let local = 0;
  try { local = Number(localStorage.getItem(`papote_read_${me.uid}_${chatId}`)) || 0; } catch {}
  return Math.max(local, readMs(chats.find((c) => c.id === chatId), me.uid));
}
function markRead(chatId, ms) {
  try { localStorage.setItem(`papote_read_${me.uid}_${chatId}`, String(ms || Date.now())); } catch {}
}

// ---------- Connexion / inscription ----------
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const which = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('active', t === tab);
      t.setAttribute('aria-selected', String(t === tab));
    });
    $('signupForm').hidden = which !== 'signup';
    $('loginForm').hidden = which !== 'login';
    setMsg($('authMsg'), '');
  });
});

// Réserve le pseudo + crée le profil, en une seule fois
async function claimUsername(user, username) {
  const lower = username.toLowerCase();
  const batch = writeBatch(db);
  batch.set(doc(db, 'usernames', lower), { uid: user.uid });
  batch.set(doc(db, 'users', user.uid), { username, usernameLower: lower, createdAt: serverTimestamp() });
  await batch.commit();
}

async function usernameTaken(username) {
  const snap = await getDoc(doc(db, 'usernames', username.toLowerCase()));
  return snap.exists();
}

$('signupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button[type=submit]');
  const email = f.email.value.trim();
  const username = f.username.value.trim();
  const password = f.password.value;
  if (!USERNAME_RE.test(username)) return setMsg($('authMsg'), 'Pseudo : 3 à 20 caractères (lettres, chiffres, _ ou .).');

  btn.disabled = true;
  setMsg($('authMsg'), '');
  pendingSignup = true;
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    try {
      if (await usernameTaken(username)) throw Object.assign(new Error('taken'), { code: 'taken' });
      await claimUsername(cred.user, username);
    } catch (err) {
      // Le pseudo n'a pas pu être pris : on annule le compte pour pouvoir réessayer
      await cred.user.delete().catch(() => {});
      throw err;
    }
    pendingSignup = false;
    await loadProfile(cred.user);
  } catch (err) {
    pendingSignup = false;
    if (err.code === 'taken' || err.code === 'permission-denied') {
      setMsg($('authMsg'), 'Ce pseudo est déjà pris, choisis-en un autre.');
    } else {
      setMsg($('authMsg'), friendlyError(err));
    }
    show('authScreen');
  } finally {
    btn.disabled = false;
  }
});

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  setMsg($('authMsg'), '');
  try {
    await signInWithEmailAndPassword(auth, f.email.value.trim(), f.password.value);
  } catch (err) {
    setMsg($('authMsg'), friendlyError(err));
  } finally {
    btn.disabled = false;
  }
});

$('forgotBtn').addEventListener('click', async () => {
  const email = $('loginForm').email.value.trim();
  if (!email) return setMsg($('authMsg'), "Écris d'abord ton email au-dessus.");
  try {
    await sendPasswordResetEmail(auth, email);
  } catch { /* on ne dit pas si l'email existe ou non */ }
  setMsg($('authMsg'), 'Si un compte existe, un email pour changer le mot de passe vient d’être envoyé.', true);
});

$('pickForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = e.target.username.value.trim();
  if (!USERNAME_RE.test(username)) return setMsg($('pickMsg'), 'Pseudo : 3 à 20 caractères (lettres, chiffres, _ ou .).');
  try {
    if (await usernameTaken(username)) return setMsg($('pickMsg'), 'Ce pseudo est déjà pris.');
    await claimUsername(auth.currentUser, username);
    await loadProfile(auth.currentUser);
  } catch (err) {
    setMsg($('pickMsg'), err.code === 'permission-denied' ? 'Ce pseudo est déjà pris.' : friendlyError(err));
  }
});

document.querySelectorAll('[data-logout]').forEach((b) => b.addEventListener('click', () => signOut(auth)));

// ---------- Session ----------
let pendingSignup = false;

onAuthStateChanged(auth, async (user) => {
  cleanup();
  if (!user) { show('authScreen'); return; }
  if (pendingSignup) return; // l'inscription s'occupe de la suite
  show('loading');
  try {
    await loadProfile(user);
  } catch {
    show('authScreen');
    setMsg($('authMsg'), 'Impossible de charger ton profil. Vérifie ta connexion.');
  }
});

async function loadProfile(user) {
  const snap = await getDoc(doc(db, 'users', user.uid));
  if (!snap.exists()) { show('pickScreen'); return; }
  me = { uid: user.uid, username: snap.data().username };
  // Les couleurs choisies sur un autre appareil reviennent avec le compte
  if (snap.data().prefs) Theme.set(snap.data().prefs);
  refreshSettingsUI();
  $('meName').textContent = me.username;
  paintAvatar($('meAvatar'), me.username);
  show('app');
  listenChats();
  listenPeople();
}

function cleanup() {
  unsubChats?.(); unsubChats = null;
  unsubPeople?.(); unsubPeople = null;
  unsubMessages?.(); unsubMessages = null;
  me = null; chats = []; people = []; openChatId = null;
  $('peopleList').replaceChildren();
  $('app').classList.remove('in-chat');
  $('chatInner').hidden = true;
  $('chatEmpty').hidden = false;
}

// ---------- Liste des amis et demandes ----------
function otherUid(chat) { return chat.members.find((u) => u !== me.uid); }
function otherName(chat) { return chat.names?.[otherUid(chat)] || '?'; }

function listenChats() {
  const q = query(collection(db, 'chats'), where('members', 'array-contains', me.uid));
  unsubChats = onSnapshot(q, (snap) => {
    chats = snap.docs
      .map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }))
      .sort((a, b) => toDate(b.lastAt) - toDate(a.lastAt)); // plus récentes en haut
    renderLists();
    if (openChatId) {
      const c = chats.find((x) => x.id === openChatId);
      if (!c) { closeChat(); toast('Cette conversation a été supprimée.'); }
      else { renderChatState(c); paintSeen(); markSeen(openChatId); }
    }
  }, (err) => {
    console.error(err);
    toast('Impossible de charger tes amis.');
  });
}

function renderLists() {
  const reqList = $('requestsList');
  const friendsList = $('friendsList');
  reqList.replaceChildren();
  friendsList.replaceChildren();

  const incoming = chats.filter((c) => !c.accepted && c.requestedBy !== me.uid);
  const outgoing = chats.filter((c) => !c.accepted && c.requestedBy === me.uid);
  const friends = chats.filter((c) => c.accepted);

  for (const c of incoming) {
    const li = document.createElement('li');
    li.className = 'request';
    const av = document.createElement('span'); av.className = 'avatar'; paintAvatar(av, otherName(c));
    const info = document.createElement('div'); info.className = 'info';
    const n = document.createElement('strong'); n.textContent = otherName(c);
    const s = document.createElement('small'); s.textContent = 'veut être ton ami';
    info.append(n, s);
    const actions = document.createElement('div'); actions.className = 'actions';
    const yes = document.createElement('button'); yes.className = 'btn primary tiny'; yes.textContent = 'Accepter';
    yes.onclick = () => acceptRequest(c);
    const no = document.createElement('button'); no.className = 'btn ghost tiny'; no.textContent = 'Refuser';
    no.onclick = () => removeChat(c, false);
    actions.append(yes, no);
    li.append(av, info, actions);
    reqList.append(li);
  }
  for (const c of outgoing) {
    const li = document.createElement('li');
    li.className = 'request';
    const av = document.createElement('span'); av.className = 'avatar'; paintAvatar(av, otherName(c));
    const info = document.createElement('div'); info.className = 'info';
    const n = document.createElement('strong'); n.textContent = otherName(c);
    const s = document.createElement('small'); s.textContent = 'demande envoyée, en attente…';
    info.append(n, s);
    const cancel = document.createElement('button'); cancel.className = 'btn ghost tiny'; cancel.textContent = 'Annuler';
    cancel.onclick = () => removeChat(c, false);
    li.append(av, info, cancel);
    reqList.append(li);
  }
  $('requestsBox').hidden = incoming.length + outgoing.length === 0;

  for (const c of friends) {
    const li = document.createElement('li');
    li.className = 'friend';
    li.tabIndex = 0;
    if (c.id === openChatId) li.classList.add('active');
    const at = toDate(c.lastAt);
    const unread = c.lastFrom && c.lastFrom !== me.uid && at.getTime() > lastRead(c.id) && c.id !== openChatId;
    if (unread) li.classList.add('unread');

    const av = document.createElement('span'); av.className = 'avatar'; paintAvatar(av, otherName(c));
    const info = document.createElement('div'); info.className = 'info';
    const name = document.createElement('div'); name.className = 'name';
    const nm = document.createElement('span'); nm.textContent = otherName(c);
    const tm = document.createElement('span'); tm.className = 'time'; tm.textContent = c.lastText ? shortTime(at) : '';
    name.append(nm, tm);
    const prev = document.createElement('div'); prev.className = 'preview';
    prev.textContent = c.lastText
      ? (c.lastFrom === me.uid ? 'Toi : ' : '') + c.lastText
      : 'Dis bonjour !';
    info.append(name, prev);
    li.append(av, info);
    if (unread) { const d = document.createElement('span'); d.className = 'dot'; li.append(d); }
    li.onclick = () => openChat(c.id);
    li.onkeydown = (e) => { if (e.key === 'Enter') openChat(c.id); };
    friendsList.append(li);
  }
  $('noFriends').hidden = friends.length > 0;

  const unreadCount = friends.filter((c) => c.lastFrom && c.lastFrom !== me.uid && toDate(c.lastAt).getTime() > lastRead(c.id) && c.id !== openChatId).length;
  const total = unreadCount + incoming.length;
  document.title = (total ? `(${total}) ` : '') + 'Papote — discute avec tes amis';

  renderPeople();
}

// ---------- Tout le monde : tous les comptes créés ----------
function chatIdWith(uid) { return [me.uid, uid].sort().join('_'); }

function listenPeople() {
  const q = query(collection(db, 'users'), orderBy('usernameLower'), limit(500));
  unsubPeople = onSnapshot(q, (snap) => {
    people = snap.docs
      .filter((d) => d.id !== me.uid)
      .map((d) => ({ uid: d.id, username: d.data().username }));
    renderPeople();
  }, (err) => {
    console.error(err);
    $('noPeople').hidden = false;
    $('noPeople').textContent = 'Impossible de charger la liste des membres.';
  });
}

function renderPeople() {
  const list = $('peopleList');
  if (!me) return;
  list.replaceChildren();
  // Le champ "Chercher ou ajouter" sert aussi à filtrer la liste
  const search = $('addForm').username.value.trim().toLowerCase();
  const shown = people.filter((p) => p.username.toLowerCase().includes(search));
  $('peopleCount').textContent = people.length ? `(${people.length})` : '';

  for (const p of shown) {
    const c = chats.find((x) => x.id === chatIdWith(p.uid));
    const li = document.createElement('li');
    li.className = 'person';
    const av = document.createElement('span'); av.className = 'avatar'; paintAvatar(av, p.username);
    const info = document.createElement('div'); info.className = 'info'; info.textContent = p.username;
    li.append(av, info);

    if (c?.accepted) {
      const b = document.createElement('button'); b.className = 'btn ghost tiny'; b.textContent = 'Discuter';
      b.onclick = () => openChat(c.id);
      li.append(b);
    } else if (c && c.requestedBy === me.uid) {
      const t = document.createElement('span'); t.className = 'tag'; t.textContent = 'Demande envoyée';
      li.append(t);
    } else if (c) {
      const b = document.createElement('button'); b.className = 'btn primary tiny'; b.textContent = 'Accepter';
      b.onclick = () => acceptRequest(c);
      li.append(b);
    } else {
      const b = document.createElement('button'); b.className = 'btn primary tiny'; b.textContent = 'Ajouter';
      b.onclick = async () => {
        b.disabled = true;
        try {
          await sendRequest(p.uid, p.username);
          toast(`Demande envoyée à ${p.username} !`);
        } catch (err) {
          console.error(err);
          b.disabled = false;
          toast(err.code === 'permission-denied'
            ? 'Impossible pour le moment. Peut-être que cette personne t’a déjà ajouté : regarde tes demandes.'
            : friendlyError(err));
        }
      };
      li.append(b);
    }
    list.append(li);
  }

  const empty = $('noPeople');
  empty.hidden = shown.length > 0;
  empty.textContent = search
    ? `Personne ne correspond à « ${search} ».`
    : 'Personne d’autre ne s’est encore inscrit. Partage le site à tes amis !';
}

$('addForm').username.addEventListener('input', () => { setMsg($('addMsg'), ''); renderPeople(); });

// Envoie une demande d'ami (crée la conversation, en attente d'acceptation)
async function sendRequest(uid, otherName) {
  const members = [me.uid, uid].sort();
  await setDoc(doc(db, 'chats', members.join('_')), {
    members,
    names: { [me.uid]: me.username, [uid]: otherName },
    requestedBy: me.uid,
    accepted: false,
    createdAt: serverTimestamp(),
    lastAt: serverTimestamp(),
    lastText: '',
    lastFrom: '',
  });
}

// Ajouter un ami avec son pseudo
$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = e.target.username;
  const name = input.value.trim();
  const msg = $('addMsg');
  setMsg(msg, '');
  if (!USERNAME_RE.test(name)) return setMsg(msg, "Ce pseudo n'est pas valide.");
  if (name.toLowerCase() === me.username.toLowerCase()) return setMsg(msg, "C'est toi ça 😄");

  try {
    const snap = await getDoc(doc(db, 'usernames', name.toLowerCase()));
    if (!snap.exists()) return setMsg(msg, `Personne ne s'appelle « ${name} ».`);
    const uid = snap.data().uid;
    const chatId = chatIdWith(uid);

    const existing = chats.find((c) => c.id === chatId);
    if (existing) {
      if (existing.accepted) { openChat(chatId); return setMsg(msg, 'Vous êtes déjà amis.', true); }
      if (existing.requestedBy === me.uid) return setMsg(msg, 'Demande déjà envoyée, attends sa réponse.', true);
      await acceptRequest(existing);
      input.value = '';
      renderPeople();
      return setMsg(msg, 'Vous êtes maintenant amis !', true);
    }

    const other = await getDoc(doc(db, 'users', uid));
    const otherName = other.exists() ? other.data().username : name;
    await sendRequest(uid, otherName);
    input.value = '';
    renderPeople();
    setMsg(msg, `Demande envoyée à ${otherName} !`, true);
  } catch (err) {
    console.error(err);
    setMsg(msg, err.code === 'permission-denied'
      ? 'Impossible pour le moment. Peut-être que cette personne t’a déjà ajouté : regarde tes demandes.'
      : friendlyError(err));
  }
});

async function acceptRequest(c) {
  try {
    await updateDoc(doc(db, 'chats', c.id), { accepted: true });
    toast(`Tu es maintenant ami avec ${otherName(c)} !`);
  } catch (err) {
    console.error(err);
    toast('Impossible d’accepter la demande.');
  }
}

async function removeChat(c, ask = true) {
  if (ask && !confirm(`Retirer ${otherName(c)} de tes amis ? Votre conversation sera supprimée pour vous deux.`)) return;
  try {
    await deleteDoc(doc(db, 'chats', c.id));
    if (openChatId === c.id) closeChat();
  } catch (err) {
    console.error(err);
    toast('Action impossible pour le moment.');
  }
}

// ---------- Conversation ----------
function openChat(chatId) {
  const c = chats.find((x) => x.id === chatId);
  if (!c) return;
  openChatId = chatId;
  unsubMessages?.();
  $('chatEmpty').hidden = true;
  $('chatInner').hidden = false;
  $('app').classList.add('in-chat');
  $('chatName').textContent = otherName(c);
  paintAvatar($('chatAvatar'), otherName(c));
  $('messages').replaceChildren();
  mediaCache.clear();
  renderedIds.clear();
  currentMsgs = [];
  closeReactPicker();
  stickToBottom = true;
  renderChatState(c);
  renderLists();

  const q = query(collection(db, 'chats', chatId, 'messages'), orderBy('at'), limitToLast(200));
  unsubMessages = onSnapshot(q, (snap) => {
    if (openChatId !== chatId) return;
    renderMessages(snap.docs.map((d) => ({
      id: d.id,
      pending: d.metadata.hasPendingWrites,
      ...d.data({ serverTimestamps: 'estimate' }),
    })));
    markRead(chatId, Date.now());
    markSeen(chatId);
  }, (err) => {
    console.error(err);
    toast('Impossible de charger les messages.');
  });

  if (matchMedia('(min-width: 761px)').matches) $('sendForm').text.focus();
}

function closeChat() {
  unsubMessages?.(); unsubMessages = null;
  closeReactPicker();
  currentMsgs = [];
  if (openChatId) markRead(openChatId, Date.now());
  openChatId = null;
  $('app').classList.remove('in-chat');
  $('chatInner').hidden = true;
  $('chatEmpty').hidden = false;
  renderLists();
}

function renderChatState(c) {
  $('pendingNote').hidden = true;
  $('sendForm').hidden = !c.accepted;
}

// ---------- Photos, vidéos, fichiers ----------
function fileKind(type) {
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return 'file';
}
function fileLabel(f) {
  const k = fileKind(f.type || '');
  if (k === 'image') return '📷 Photo';
  if (k === 'video') return '🎬 Vidéo';
  if (k === 'audio') return '🎵 Audio';
  const t = '📎 ' + f.name;
  return t.length > 80 ? t.slice(0, 80) + '…' : t;
}
function prettySize(n) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} Ko`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1).replace('.', ',')} Mo`;
  return `${(n / 1024 ** 3).toFixed(1).replace('.', ',')} Go`;
}

function fileCard(f) {
  const a = document.createElement('a');
  a.className = 'file-card';
  a.href = f.url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.download = f.name;
  a.innerHTML = '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M12 12v6M9 15l3 3 3-3"/></svg>';
  const info = document.createElement('span');
  const n = document.createElement('strong'); n.textContent = f.name;
  const s = document.createElement('small'); s.textContent = prettySize(f.size || 0);
  info.append(n, s);
  a.append(info);
  return a;
}

// Les photos/vidéos déjà affichées sont gardées : une vidéo en lecture
// ne s'arrête pas quand un nouveau message arrive.
const mediaCache = new Map();
let stickToBottom = true;
const renderedIds = new Set(); // messages déjà affichés (pour n'animer que les nouveaux)
let currentMsgs = [];          // messages de la conversation ouverte
$('messages').addEventListener('scroll', () => {
  const box = $('messages');
  stickToBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
});
function keepBottom() { if (stickToBottom) $('messages').scrollTop = $('messages').scrollHeight; }

function mediaFor(m) {
  if (mediaCache.has(m.id)) return mediaCache.get(m.id);
  const f = m.file;
  const kind = fileKind(f.type || '');
  let el;
  if (kind === 'image') {
    el = document.createElement('a');
    el.href = f.url; el.target = '_blank'; el.rel = 'noopener';
    const img = document.createElement('img');
    img.src = f.url; img.alt = f.name; img.loading = 'lazy';
    img.onload = keepBottom;
    // Format que le navigateur ne sait pas afficher (ex. HEIC) : on montre le fichier
    img.onerror = () => { const card = fileCard(f); mediaCache.set(m.id, card); el.replaceWith(card); };
    el.append(img);
  } else if (kind === 'video' || kind === 'audio') {
    el = document.createElement(kind);
    el.src = f.url; el.controls = true; el.preload = 'metadata';
    el.playsInline = true;
    el.onloadedmetadata = keepBottom;
    el.onerror = () => { const card = fileCard(f); mediaCache.set(m.id, card); el.replaceWith(card); };
  } else {
    el = fileCard(f);
  }
  mediaCache.set(m.id, el);
  return el;
}

function renderMessages(msgs) {
  currentMsgs = msgs;
  const box = $('messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  box.replaceChildren();
  if (!msgs.length) {
    const d = document.createElement('div');
    d.className = 'day';
    d.textContent = 'Aucun message pour l’instant. Lance la discussion !';
    box.append(d);
  }
  let lastDay = '';
  for (const m of msgs) {
    const at = toDate(m.at);
    const day = at.toDateString();
    if (day !== lastDay) {
      lastDay = day;
      const d = document.createElement('div');
      d.className = 'day';
      d.textContent = dayLabel(at);
      box.append(d);
    }
    const mine = m.from === me.uid;
    const b = document.createElement('div');
    b.className = 'bubble' + (mine ? ' me' : '') + (m.file ? ' media' : '');
    // Seuls les nouveaux messages font la petite animation (pas à chaque mise à jour)
    if (!renderedIds.has(m.id)) { b.classList.add('new'); renderedIds.add(m.id); }
    b.dataset.id = m.id;
    b.dataset.at = String(at.getTime());
    if (m.file) {
      b.append(mediaFor(m));
      if (m.text) { const c = document.createElement('div'); c.className = 'caption'; c.textContent = m.text; b.append(c); }
    } else {
      b.append(document.createTextNode(m.text));
    }
    const t = document.createElement('time');
    t.textContent = hhmm(at);
    if (mine) {
      // ✓ envoyé, ✓✓ vu (mis à jour par paintSeen)
      b.dataset.pending = m.pending ? '1' : '';
      const ticks = document.createElement('span');
      ticks.className = 'ticks';
      t.append(ticks);
    }
    b.append(t);

    // Bouton pour réagir (visible au survol, sur ordinateur)
    const rb = document.createElement('button');
    rb.type = 'button';
    rb.className = 'react-btn';
    rb.title = 'Réagir';
    rb.setAttribute('aria-label', 'Réagir avec un emoji');
    rb.innerHTML = ICONS.smile;
    b.append(rb);

    const pill = reactionsPill(m);
    if (pill) { b.classList.add('has-reacts'); b.append(pill); }
    box.append(b);
  }
  paintSeen();
  if (nearBottom || msgs.at(-1)?.from === me.uid) { box.scrollTop = box.scrollHeight; stickToBottom = true; }
}

// ---------- Vu / pas encore vu ----------
const ICONS = {
  pending: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2"/></svg>',
  sent: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  seen: '<svg viewBox="0 0 24 24"><path d="M1.5 12.5l4.5 4.5 9.5-9.5M11 17l9.5-9.5"/></svg>',
  smile: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/></svg>',
};
const TICK_LABEL = { pending: 'Envoi…', sent: 'Envoyé', seen: 'Vu' };

// Met les ✓ / ✓✓ à jour, et "Vu à 14:32" sous ton dernier message
function paintSeen() {
  const c = chats.find((x) => x.id === openChatId);
  const box = $('messages');
  box.querySelector('.seen-label')?.remove();
  if (!c) return;
  const theirRead = readMs(c, otherUid(c));
  box.querySelectorAll('.bubble.me').forEach((b) => {
    const state = b.dataset.pending ? 'pending' : theirRead >= Number(b.dataset.at) ? 'seen' : 'sent';
    const t = b.querySelector('.ticks');
    if (!t || t.dataset.state === state) return;
    t.dataset.state = state;
    t.innerHTML = ICONS[state];
    t.title = TICK_LABEL[state];
  });
  const last = currentMsgs.at(-1);
  if (last && last.from === me.uid && !last.pending && theirRead >= toDate(last.at).getTime()) {
    const d = new Date(theirRead);
    const label = document.createElement('div');
    label.className = 'seen-label';
    label.textContent = d.toDateString() === new Date().toDateString()
      ? `Vu à ${hhmm(d)}`
      : `Vu ${dayLabel(d).toLowerCase()} à ${hhmm(d)}`;
    box.append(label);
    keepBottom();
  }
}

// Dit à ton ami que tu as vu ses messages (seulement si la page est vraiment affichée)
const seenWriting = new Set();
function markSeen(chatId) {
  if (!chatId || chatId !== openChatId || document.visibilityState !== 'visible') return;
  const c = chats.find((x) => x.id === chatId);
  if (!c?.accepted || seenWriting.has(chatId)) return;
  const lastTheirs = currentMsgs.findLast((m) => m.from !== me.uid);
  if (!lastTheirs || readMs(c, me.uid) >= toDate(lastTheirs.at).getTime()) return;
  seenWriting.add(chatId);
  updateDoc(doc(db, 'chats', chatId), { [`reads.${me.uid}`]: serverTimestamp() })
    .catch((err) => console.error('vu', err))
    .finally(() => seenWriting.delete(chatId));
}
document.addEventListener('visibilitychange', () => markSeen(openChatId));
window.addEventListener('focus', () => markSeen(openChatId));

// ---------- Réagir à un message avec un emoji ----------
const QUICK_EMOJIS = ['❤️', '😂', '😮', '😢', '😡', '👍'];
const MORE_EMOJIS = [
  '🔥', '🥰', '😍', '😆', '🤣', '😊', '😎', '🤔', '😭', '😱', '🙏', '👏',
  '🎉', '💯', '👀', '🤝', '💀', '🥳', '😴', '🤯', '👌', '✨', '💪', '😅',
];

function nameOfUid(uid) {
  if (uid === me.uid) return 'Toi';
  const c = chats.find((x) => x.id === openChatId);
  return c?.names?.[uid] || '?';
}

// La petite bulle sous le message : ❤️😂 2
function reactionsPill(m) {
  const entries = Object.entries(m.reactions || {}).filter(([, e]) => typeof e === 'string' && e);
  if (!entries.length) return null;
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'reacts' + (m.reactions[me.uid] ? ' mine' : '');
  const distinct = [...new Set(entries.map(([, e]) => e))];
  pill.textContent = distinct.join('') + (entries.length > 1 ? ` ${entries.length}` : '');
  const who = entries.map(([uid, e]) => `${nameOfUid(uid)} : ${e}`).join(', ');
  pill.title = who;
  pill.setAttribute('aria-label', `Réactions — ${who}`);
  return pill;
}

async function react(msgId, emoji) {
  const chatId = openChatId;
  const m = currentMsgs.find((x) => x.id === msgId);
  if (!chatId || !m) return;
  const same = m.reactions?.[me.uid] === emoji;
  try {
    await updateDoc(doc(db, 'chats', chatId, 'messages', msgId), {
      [`reactions.${me.uid}`]: same ? deleteField() : emoji, // retoucher le même emoji le retire
    });
  } catch (err) {
    console.error('réaction', err);
    toast('Réaction pas envoyée. Réessaie.');
  }
}

const reactPicker = document.createElement('div');
reactPicker.className = 'react-picker';
reactPicker.hidden = true;
reactPicker.setAttribute('role', 'dialog');
reactPicker.setAttribute('aria-label', 'Choisis un emoji');
document.body.append(reactPicker);
let pickerMsgId = null;

function emojiButton(e, current) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = e;
  b.setAttribute('aria-label', e);
  b.setAttribute('aria-pressed', String(e === current));
  b.onclick = () => { const id = pickerMsgId; closeReactPicker(); react(id, e); };
  return b;
}

function openReactPicker(bubble) {
  const msgId = bubble.dataset.id;
  const m = currentMsgs.find((x) => x.id === msgId);
  const c = chats.find((x) => x.id === openChatId);
  if (!m || !c?.accepted) return;
  closeReactPicker();
  pickerMsgId = msgId;
  const current = m.reactions?.[me.uid];
  const row = document.createElement('div');
  row.className = 'row';
  for (const e of QUICK_EMOJIS) row.append(emojiButton(e, current));
  const more = document.createElement('div');
  more.className = 'more';
  more.hidden = true;
  for (const e of MORE_EMOJIS) more.append(emojiButton(e, current));
  const plus = document.createElement('button');
  plus.type = 'button';
  plus.className = 'plus';
  plus.title = 'Plus d’emojis';
  plus.setAttribute('aria-label', 'Plus d’emojis');
  plus.setAttribute('aria-expanded', 'false');
  plus.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
  plus.onclick = () => {
    more.hidden = !more.hidden;
    plus.setAttribute('aria-expanded', String(!more.hidden));
    placePicker(bubble);
  };
  row.append(plus);
  reactPicker.replaceChildren(row, more);
  reactPicker.hidden = false;
  placePicker(bubble);
  bubble.classList.add('picking');
  reactPicker.querySelector('button')?.focus({ preventScroll: true });
}

// Place le choix d'emojis juste au-dessus (ou en dessous) du message
function placePicker(bubble) {
  const r = bubble.getBoundingClientRect();
  const w = reactPicker.offsetWidth;
  const h = reactPicker.offsetHeight;
  let top = r.top - h - 8;
  if (top < 8) top = Math.min(r.bottom + 8, innerHeight - h - 8);
  let left = bubble.classList.contains('me') ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, innerWidth - w - 8));
  reactPicker.style.top = `${Math.max(8, top)}px`;
  reactPicker.style.left = `${left}px`;
}

function closeReactPicker() {
  if (reactPicker.hidden) return;
  reactPicker.hidden = true;
  pickerMsgId = null;
  document.querySelectorAll('.bubble.picking').forEach((b) => b.classList.remove('picking'));
}

const messagesBox = $('messages');
let pressTimer = null;
let pressStart = null;
let suppressClick = false;

messagesBox.addEventListener('click', (e) => {
  // Après un appui long, on n'ouvre pas la photo / le lien qui était sous le doigt
  if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); return; }
  const btn = e.target.closest('.react-btn, .reacts');
  if (!btn) return;
  const bubble = btn.closest('.bubble');
  if (pickerMsgId === bubble.dataset.id) closeReactPicker();
  else openReactPicker(bubble);
}, true);

// Sur téléphone : appui long sur un message pour réagir
messagesBox.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse') return;
  const bubble = e.target.closest('.bubble');
  if (!bubble || e.target.closest('video, audio, .reacts, .react-btn')) return;
  pressStart = { x: e.clientX, y: e.clientY };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    pressTimer = null;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 600);
    navigator.vibrate?.(12);
    openReactPicker(bubble);
  }, 450);
});
const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
messagesBox.addEventListener('pointerup', cancelPress);
messagesBox.addEventListener('pointercancel', cancelPress);
messagesBox.addEventListener('pointermove', (e) => {
  if (pressTimer && pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) cancelPress();
});
// Sur téléphone, l'appui long ouvre les emojis au lieu du menu du navigateur
messagesBox.addEventListener('contextmenu', (e) => {
  if (matchMedia('(pointer: coarse)').matches && e.target.closest('.bubble')) e.preventDefault();
});

document.addEventListener('pointerdown', (e) => {
  if (!reactPicker.hidden && !reactPicker.contains(e.target) && !e.target.closest('.react-btn, .reacts')) closeReactPicker();
});
messagesBox.addEventListener('scroll', closeReactPicker);
window.addEventListener('resize', closeReactPicker);

// Envoie un fichier : d'abord dans Firebase Storage, puis un message qui pointe dessus
let currentUpload = null;
let uploadCanceled = false;

function showUpload(text, pct) {
  $('uploadBar').hidden = false;
  $('uploadLabel').textContent = text;
  $('uploadProgress').value = pct;
}

async function sendFiles(files) {
  const list = [...files];
  if (!list.length || !openChatId) return;
  const c = chats.find((x) => x.id === openChatId);
  if (!c?.accepted) return;
  const chatId = openChatId;
  uploadCanceled = false;
  for (let i = 0; i < list.length && !uploadCanceled; i++) {
    const prefix = list.length > 1 ? `(${i + 1}/${list.length}) ` : '';
    await sendOneFile(chatId, list[i], prefix);
  }
  currentUpload = null;
  $('uploadBar').hidden = true;
}

async function sendOneFile(chatId, file, prefix) {
  const msgRef = doc(collection(db, 'chats', chatId, 'messages'));
  // Nom de fichier sans caractères gênants pour une adresse
  const safeName = (file.name || 'fichier').replace(/[\/\\#?\[\]*%]/g, '_').slice(-150);
  const path = `chats/${chatId}/${msgRef.id}/${safeName}`;
  const type = file.type || 'application/octet-stream';
  const name = (file.name || 'fichier').slice(0, 200);
  showUpload(`${prefix}Envoi de ${name}…`, 0);
  try {
    const task = uploadBytesResumable(fileRef(storage, path), file, { contentType: type });
    currentUpload = task;
    task.on('state_changed', (s) => {
      const pct = s.totalBytes ? (s.bytesTransferred / s.totalBytes) * 100 : 0;
      showUpload(`${prefix}Envoi de ${name}… ${Math.round(pct)} % (${prettySize(s.totalBytes)})`, pct);
    });
    await task;
    const url = await getDownloadURL(task.snapshot.ref);
    const fileInfo = { url, path, name, type, size: file.size };
    const batch = writeBatch(db);
    batch.set(msgRef, { from: me.uid, text: '', at: serverTimestamp(), file: fileInfo });
    batch.update(doc(db, 'chats', chatId), {
      lastAt: serverTimestamp(),
      lastText: fileLabel(fileInfo),
      lastFrom: me.uid,
    });
    await batch.commit();
  } catch (err) {
    if (err.code === 'storage/canceled') { uploadCanceled = true; toast('Envoi annulé.'); return; }
    console.error(err);
    toast(err.code === 'storage/unauthorized' || err.code === 'storage/unknown'
      ? `Impossible d’envoyer « ${name} » pour le moment.`
      : `« ${name} » n’a pas pu être envoyé. Réessaie.`);
  }
}

$('attachBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = ''; // pour pouvoir renvoyer le même fichier ensuite
  sendFiles(files);
});
$('uploadCancel').addEventListener('click', () => { uploadCanceled = true; currentUpload?.cancel(); });

// Coller une image (Ctrl+V) dans la zone de texte l'envoie
$('sendForm').text.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); sendFiles(files); }
});

// Glisser-déposer des fichiers sur la conversation
let dragDepth = 0;
const chatInner = $('chatInner');
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
chatInner.addEventListener('dragenter', (e) => {
  if (!hasFiles(e) || $('sendForm').hidden) return;
  e.preventDefault();
  dragDepth++;
  $('dropHint').hidden = false;
});
chatInner.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
chatInner.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropHint').hidden = true; } });
chatInner.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('dropHint').hidden = true;
  if (!$('sendForm').hidden) sendFiles(e.dataTransfer.files);
});

// Envoyer un message
const textarea = $('sendForm').text;
function autoGrow() {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 140) + 'px';
}
textarea.addEventListener('input', autoGrow);
textarea.addEventListener('keydown', (e) => {
  // Entrée = envoyer, Maj+Entrée = nouvelle ligne (sur ordinateur)
  if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer: fine)').matches) {
    e.preventDefault();
    $('sendForm').requestSubmit();
  }
});

$('sendForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = textarea.value.trim();
  if (!text || !openChatId) return;
  if (text.length > 1000) return toast('Message trop long (1000 caractères max).');
  const chatId = openChatId;
  textarea.value = '';
  autoGrow();
  try {
    const batch = writeBatch(db);
    batch.set(doc(collection(db, 'chats', chatId, 'messages')), { from: me.uid, text, at: serverTimestamp() });
    batch.update(doc(db, 'chats', chatId), {
      lastAt: serverTimestamp(),
      lastText: text.length > 80 ? text.slice(0, 80) + '…' : text,
      lastFrom: me.uid,
    });
    await batch.commit();
  } catch (err) {
    console.error(err);
    textarea.value = text;
    autoGrow();
    toast('Message pas envoyé. Réessaie.');
  }
});

$('backBtn').addEventListener('click', closeChat);
$('removeBtn').addEventListener('click', () => {
  const c = chats.find((x) => x.id === openChatId);
  if (c) removeChat(c, true);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!reactPicker.hidden) { closeReactPicker(); return; }
  if (openChatId && !$('settings').open) closeChat();
});

// ---------- Personnaliser : mode nuit, couleur, fond, taille ----------
const Theme = window.PapoteTheme;
const COLORS = [
  ['#6d4aff', 'Violet'], ['#2f6bff', 'Bleu'], ['#0ea5b7', 'Turquoise'], ['#16a34a', 'Vert'],
  ['#eab308', 'Jaune'], ['#f97316', 'Orange'], ['#e5484d', 'Rouge'], ['#ec4899', 'Rose'], ['#475569', 'Gris'],
];

// Construit les pastilles de couleur (+ une pastille "arc-en-ciel" pour choisir n'importe quelle couleur)
const swatchBox = $('swatches');
for (const [hex, name] of COLORS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'swatch';
  b.dataset.color = hex;
  b.style.setProperty('--c', hex);
  b.title = name;
  b.setAttribute('aria-label', name);
  b.onclick = () => setPrefs({ accent: hex });
  swatchBox.append(b);
}
const custom = document.createElement('label');
custom.className = 'swatch custom';
custom.title = 'Choisir ma couleur';
custom.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
const picker = document.createElement('input');
picker.type = 'color';
picker.setAttribute('aria-label', 'Choisir ma propre couleur');
picker.addEventListener('input', () => setPrefs({ accent: picker.value }));
custom.append(picker);
swatchBox.append(custom);

// Met les boutons du panneau à jour (lequel est sélectionné)
function refreshSettingsUI() {
  const p = Theme.get();
  document.querySelectorAll('#themeChoice [data-theme]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.theme === p.theme)));
  document.querySelectorAll('#sizeChoice [data-size]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.size === p.textSize)));
  document.querySelectorAll('#walls [data-wall]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.wall === p.wallpaper)));
  let known = false;
  swatchBox.querySelectorAll('[data-color]').forEach((b) => {
    const on = b.dataset.color === p.accent;
    if (on) known = true;
    b.setAttribute('aria-pressed', String(on));
  });
  custom.setAttribute('aria-pressed', String(!known));
  picker.value = p.accent;
}

// Sauvegarde dans le compte (attend un peu, pour ne pas écrire à chaque mouvement du sélecteur)
let saveTimer;
function setPrefs(change) {
  const p = Theme.set(change);
  refreshSettingsUI();
  if (!me) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    updateDoc(doc(db, 'users', me.uid), { prefs: p }).catch((err) => console.error('prefs', err));
  }, 600);
}

document.querySelectorAll('#themeChoice [data-theme]').forEach((b) => b.addEventListener('click', () => setPrefs({ theme: b.dataset.theme })));
document.querySelectorAll('#sizeChoice [data-size]').forEach((b) => b.addEventListener('click', () => setPrefs({ textSize: b.dataset.size })));
document.querySelectorAll('#walls [data-wall]').forEach((b) => b.addEventListener('click', () => setPrefs({ wallpaper: b.dataset.wall })));
$('resetPrefs').addEventListener('click', () => setPrefs({ ...Theme.DEFAULT }));

// Bouton lune / soleil : passe directement en mode nuit ou jour
document.querySelectorAll('[data-theme-toggle]').forEach((b) => b.addEventListener('click', () => {
  setPrefs({ theme: Theme.isDark() ? 'light' : 'dark' });
}));

const settings = $('settings');
$('settingsBtn').addEventListener('click', () => { refreshSettingsUI(); settings.showModal(); });
settings.querySelectorAll('[data-close-settings]').forEach((b) => b.addEventListener('click', () => settings.close()));
// Toucher en dehors du panneau le ferme
settings.addEventListener('click', (e) => { if (e.target === settings) settings.close(); });

refreshSettingsUI();
