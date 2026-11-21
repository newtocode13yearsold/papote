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
  arrayUnion, arrayRemove,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';
import {
  getStorage, ref as fileRef, uploadBytesResumable, getDownloadURL,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-storage.js';
import {
  getDatabase, ref as dbRef, onValue, set as dbSet, onDisconnect, serverTimestamp as dbNow,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
auth.languageCode = 'fr';
const db = getFirestore(app);
const storage = getStorage(app); // Firebase Storage = les photos, vidéos et fichiers envoyés
const rtdb = getDatabase(app);    // Realtime Database = qui est en ligne

const $ = (id) => document.getElementById(id);
const USERNAME_RE = /^[A-Za-z0-9_.]{3,20}$/;

let me = null;          // { uid, username }
let chats = [];         // mes conversations (amis + demandes)
let openChatId = null;  // conversation ouverte
let people = [];        // tous les membres inscrits (sauf moi)
let peopleByUid = new Map(); // uid -> pseudo (pour les noms dans les groupes)
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

document.querySelectorAll('[data-logout]').forEach((b) => b.addEventListener('click', async () => {
  // On se met "hors ligne" avant de partir (après, on n'a plus le droit d'écrire)
  if (me) {
    const wait = (p) => Promise.race([p, new Promise((r) => setTimeout(r, 1500))]); // sans réseau, on n'attend pas
    await wait(onDisconnect(myStatusRef()).cancel().catch(() => {}));
    await wait(setMyStatus(false));
  }
  signOut(auth);
}));

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
  startPresence();
  refreshNotifUI();
}

function cleanup() {
  unsubChats?.(); unsubChats = null;
  unsubPeople?.(); unsubPeople = null;
  unsubMessages?.(); unsubMessages = null;
  stopPresence();
  chatsLoaded = false;
  knownLastAt.clear();
  me = null; chats = []; people = []; peopleByUid = new Map(); openChatId = null;
  replyingTo = null;
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  $('replyBar').hidden = true;
  $('peopleList').replaceChildren();
  $('app').classList.remove('in-chat');
  $('chatInner').hidden = true;
  $('chatEmpty').hidden = false;
}

// ---------- Liste des amis et demandes ----------
// Une conversation est soit entre 2 amis, soit un groupe (group = true)
function isGroup(chat) { return !!chat?.group; }
function otherUid(chat) { return chat.members.find((u) => u !== me.uid); }
function otherName(chat) { return chat.names?.[otherUid(chat)] || '?'; }
function chatTitle(chat) { return isGroup(chat) ? (chat.title || 'Groupe') : otherName(chat); }
function paintChatAvatar(el, chat) {
  paintAvatar(el, chatTitle(chat));
  el.classList.toggle('group', isGroup(chat));
}

// Le pseudo de n'importe qui (moi, un ami, ou un membre d'un groupe)
function userName(uid) {
  if (me && uid === me.uid) return me.username;
  if (peopleByUid.has(uid)) return peopleByUid.get(uid);
  for (const c of chats) if (c.names?.[uid]) return c.names[uid];
  return '?';
}

function listenChats() {
  const q = query(collection(db, 'chats'), where('members', 'array-contains', me.uid));
  unsubChats = onSnapshot(q, (snap) => {
    chats = snap.docs
      .map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }))
      .sort((a, b) => toDate(b.lastAt) - toDate(a.lastAt)); // plus récentes en haut
    checkForNews(snap);
    syncFriendStatus();
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

    const group = isGroup(c);
    const av = document.createElement('span'); av.className = 'avatar'; paintChatAvatar(av, c);
    if (!group && isOnline(otherUid(c))) { av.classList.add('online'); av.title = 'En ligne'; }
    const info = document.createElement('div'); info.className = 'info';
    const name = document.createElement('div'); name.className = 'name';
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = chatTitle(c);
    const tm = document.createElement('span'); tm.className = 'time'; tm.textContent = c.lastText ? shortTime(at) : '';
    name.append(nm, tm);
    const prev = document.createElement('div'); prev.className = 'preview';
    let who = '';
    if (c.lastFrom === me.uid) who = 'Toi : ';
    else if (group && c.lastFrom) who = `${userName(c.lastFrom)} : `;
    prev.textContent = c.lastText
      ? who + c.lastText
      : group ? `Groupe · ${c.members.length} membres` : 'Dis bonjour !';
    info.append(name, prev);
    li.append(av, info);
    if (unread) { const d = document.createElement('span'); d.className = 'dot'; li.append(d); }
    li.onclick = () => openChat(c.id);
    li.onkeydown = (e) => { if (e.key === 'Enter') openChat(c.id); };
    friendsList.append(li);
  }
  $('noFriends').hidden = friends.length > 0;
  const onlineNow = friends.filter((c) => !isGroup(c) && isOnline(otherUid(c))).length;
  $('onlineCount').textContent = onlineNow ? `· ${onlineNow} en ligne` : '';

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
    peopleByUid = new Map(people.map((p) => [p.uid, p.username]));
    renderLists(); // les noms dans les groupes peuvent avoir changé
    const c = chats.find((x) => x.id === openChatId);
    if (isGroup(c)) { if (currentMsgs.length) renderMessages(currentMsgs); paintChatStatus(); }
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
    if (c?.accepted && isOnline(p.uid)) { av.classList.add('online'); av.title = 'En ligne'; }
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
  $('chatName').textContent = chatTitle(c);
  paintChatAvatar($('chatAvatar'), c);
  $('messages').replaceChildren();
  mediaCache.clear();
  renderedIds.clear();
  currentMsgs = [];
  closeReactPicker();
  replyingTo = null;
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
  cancelReply();
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
  // Le nom du groupe peut changer pendant qu'on discute
  $('chatName').textContent = chatTitle(c);
  paintChatAvatar($('chatAvatar'), c);
  $('removeBtn').hidden = isGroup(c);
  $('groupBtn').hidden = !isGroup(c);
  $('chatHeadInfo').disabled = !isGroup(c);
  paintReplyBar();
  paintChatStatus();
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
  if (m.image) {
    // Photo rangée dans le message lui-même (pas besoin de Firebase Storage)
    const img = document.createElement('img');
    img.src = m.image.data;
    img.alt = m.image.name || 'Photo';
    img.className = 'photo';
    img.style.aspectRatio = `${m.image.w} / ${m.image.h}`;
    img.style.width = `${Math.min(320, m.image.w)}px`; // une petite image n'est pas agrandie
    img.onload = keepBottom;
    mediaCache.set(m.id, img);
    return img;
  }
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
  const group = isGroup(chats.find((x) => x.id === openChatId));
  let lastDay = '';
  let lastFrom = '';
  for (const m of msgs) {
    const at = toDate(m.at);
    const day = at.toDateString();
    if (day !== lastDay) {
      lastDay = day;
      lastFrom = '';
      const d = document.createElement('div');
      d.className = 'day';
      d.textContent = dayLabel(at);
      box.append(d);
    }
    const mine = m.from === me.uid;
    const media = m.file || m.image;
    const b = document.createElement('div');
    b.className = 'bubble' + (mine ? ' me' : '') + (media ? ' media' : '');
    // Seuls les nouveaux messages font la petite animation (pas à chaque mise à jour)
    if (!renderedIds.has(m.id)) { b.classList.add('new'); renderedIds.add(m.id); }
    b.dataset.id = m.id;
    b.dataset.at = String(at.getTime());
    // Dans un groupe : le pseudo au-dessus du premier message de chaque personne
    if (group && !mine && m.from !== lastFrom) {
      const who = document.createElement('div');
      who.className = 'sender';
      who.textContent = userName(m.from);
      who.style.color = colorFor(who.textContent);
      b.append(who);
    }
    lastFrom = m.from;
    if (m.replyTo) b.append(quoteFor(m.replyTo));
    if (media) {
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

    // Boutons pour réagir et répondre (visibles au survol, sur ordinateur)
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    const rb = document.createElement('button');
    rb.type = 'button';
    rb.className = 'react-btn';
    rb.title = 'Réagir';
    rb.setAttribute('aria-label', 'Réagir avec un emoji');
    rb.innerHTML = ICONS.smile;
    const rp = document.createElement('button');
    rp.type = 'button';
    rp.className = 'reply-btn';
    rp.title = 'Répondre';
    rp.setAttribute('aria-label', 'Répondre à ce message');
    rp.innerHTML = ICONS.reply;
    actions.append(rb, rp);
    b.append(actions);

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
  reply: '<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
};
const TICK_LABEL = { pending: 'Envoi…', sent: 'Envoyé', seen: 'Vu' };

// Met les ✓ / ✓✓ à jour, et "Vu à 14:32" sous ton dernier message
function paintSeen() {
  const c = chats.find((x) => x.id === openChatId);
  const box = $('messages');
  box.querySelector('.seen-label')?.remove();
  if (!c) return;
  // ✓✓ quand tout le monde (les autres membres) a vu le message
  const others = c.members.filter((u) => u !== me.uid);
  const theirRead = others.length ? Math.min(...others.map((u) => readMs(c, u))) : 0;
  box.querySelectorAll('.bubble.me').forEach((b) => {
    const state = b.dataset.pending ? 'pending' : theirRead >= Number(b.dataset.at) ? 'seen' : 'sent';
    const t = b.querySelector('.ticks');
    if (!t || t.dataset.state === state) return;
    t.dataset.state = state;
    t.innerHTML = ICONS[state];
    t.title = TICK_LABEL[state];
  });
  const last = currentMsgs[currentMsgs.length - 1];
  if (isGroup(c)) {
    // Groupe : "Vu par Léa, Tom" (ou "Vu par tout le monde")
    if (!last || last.from !== me.uid || last.pending) return;
    const lastMs = toDate(last.at).getTime();
    const seenBy = others.filter((u) => readMs(c, u) >= lastMs);
    if (!seenBy.length) return;
    const label = document.createElement('div');
    label.className = 'seen-label';
    label.textContent = seenBy.length === others.length && others.length > 1
      ? 'Vu par tout le monde'
      : `Vu par ${seenBy.map(userName).join(', ')}`;
    box.append(label);
    keepBottom();
    return;
  }
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
// On retient le dernier message de l'ami déjà signalé "vu" (par son id, pas par l'heure :
// l'horloge de l'ordi peut être décalée par rapport à celle de Firebase).
const seenWriting = new Set();
const seenUpTo = new Map(); // chatId -> id du dernier message de l'ami signalé "vu"
function markSeen(chatId) {
  if (!chatId || chatId !== openChatId || document.visibilityState !== 'visible') return;
  const c = chats.find((x) => x.id === chatId);
  if (!c?.accepted || seenWriting.has(chatId)) return;
  let lastTheirs = null;
  for (let i = currentMsgs.length - 1; i >= 0; i--) {
    if (currentMsgs[i].from !== me.uid) { lastTheirs = currentMsgs[i]; break; }
  }
  if (!lastTheirs || seenUpTo.get(chatId) === lastTheirs.id) return;
  if (readMs(c, me.uid) >= toDate(lastTheirs.at).getTime()) { seenUpTo.set(chatId, lastTheirs.id); return; }
  seenWriting.add(chatId);
  updateDoc(doc(db, 'chats', chatId), { [`reads.${me.uid}`]: serverTimestamp() })
    .catch((err) => console.error('vu', err)) // pas de nouvel essai pour ce message (sinon ça tourne en boucle)
    .finally(() => {
      seenUpTo.set(chatId, lastTheirs.id);
      seenWriting.delete(chatId);
      markSeen(chatId); // un message est peut-être arrivé pendant l'envoi
    });
}
document.addEventListener('visibilitychange', () => markSeen(openChatId));
window.addEventListener('focus', () => markSeen(openChatId));

// ---------- Nouvelle version du site ----------
// Si la page reste ouverte longtemps, elle garderait l'ancienne version (sans les
// nouveautés comme "Vu"). On vérifie de temps en temps et on recharge tout seul.
let appVersion = null;
async function fetchAppVersion() {
  try {
    const r = await fetch('app.js', { method: 'HEAD', cache: 'no-store' });
    return r.ok ? (r.headers.get('etag') || r.headers.get('last-modified')) : null;
  } catch { return null; }
}
async function checkForUpdate() {
  const v = await fetchAppVersion();
  if (!v) return;
  if (!appVersion) { appVersion = v; return; }
  if (v === appVersion) return;
  const busy = $('sendForm').text.value.trim() || currentUpload;
  if (busy) { toast('Nouvelle version de Papote : recharge la page quand tu as fini.'); appVersion = v; return; }
  location.reload();
}
checkForUpdate();
setInterval(checkForUpdate, 5 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });

// ---------- Réagir à un message avec un emoji ----------
const QUICK_EMOJIS = ['❤️', '😂', '😮', '😢', '😡', '👍'];
const MORE_EMOJIS = [
  '🔥', '🥰', '😍', '😆', '🤣', '😊', '😎', '🤔', '😭', '😱', '🙏', '👏',
  '🎉', '💯', '👀', '🤝', '💀', '🥳', '😴', '🤯', '👌', '✨', '💪', '😅',
];

function nameOfUid(uid) {
  return uid === me.uid ? 'Toi' : userName(uid);
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
  const replyBtn = document.createElement('button');
  replyBtn.type = 'button';
  replyBtn.className = 'reply-action';
  replyBtn.innerHTML = ICONS.reply + '<span>Répondre</span>';
  replyBtn.onclick = () => { const id = pickerMsgId; closeReactPicker(); startReply(id); };
  reactPicker.replaceChildren(row, more, replyBtn);
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

// ---------- Répondre à un message ----------
// Le message envoyé garde un petit extrait de celui d'origine : replyTo = { id, from, text }
let replyingTo = null;

function snippetOf(m) {
  const label = m.image ? '📷 Photo' : m.file ? fileLabel(m.file) : '';
  const raw = label ? label + (m.text ? ' · ' + m.text : '') : m.text || '';
  const t = raw.replace(/\s+/g, ' ').trim();
  return t.length > 120 ? t.slice(0, 120) + '…' : t;
}

// Le bloc cité en haut de la bulle (le toucher remonte jusqu'au message d'origine)
function quoteFor(r) {
  const q = document.createElement('button');
  q.type = 'button';
  q.className = 'quote';
  q.dataset.target = r.id || '';
  const txt = document.createElement('span');
  txt.className = 'q-text';
  const who = document.createElement('strong');
  who.textContent = nameOfUid(r.from);
  const t = document.createElement('span');
  t.textContent = r.text || 'Message';
  txt.append(who, t);
  q.append(txt);
  // Réponse à une photo : on montre une petite miniature de la photo
  const orig = currentMsgs.find((x) => x.id === r.id);
  if (orig?.image) {
    const th = document.createElement('img');
    th.className = 'q-thumb';
    th.src = orig.image.data;
    th.alt = '';
    q.append(th);
  }
  q.title = 'Voir le message d’origine';
  q.setAttribute('aria-label', `Réponse à ${who.textContent} : ${t.textContent}. Voir le message d’origine`);
  return q;
}

function jumpToMessage(id) {
  const el = id && $('messages').querySelector(`.bubble[data-id="${CSS.escape(id)}"]`);
  if (!el) { toast('Ce message est trop ancien pour être affiché.'); return; }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth; // relance l'animation
  el.classList.add('flash');
}

function startReply(msgId) {
  const m = currentMsgs.find((x) => x.id === msgId);
  const c = chats.find((x) => x.id === openChatId);
  if (!m || !c?.accepted) return;
  replyingTo = { id: m.id, from: m.from, text: snippetOf(m) };
  paintReplyBar();
  textarea.focus();
  keepBottom();
}

function cancelReply() {
  replyingTo = null;
  paintReplyBar();
}

function paintReplyBar() {
  const bar = $('replyBar');
  bar.hidden = !replyingTo || $('sendForm').hidden;
  if (bar.hidden) return;
  $('replyWho').textContent = replyingTo.from === me.uid ? 'Réponse à ton message' : `Réponse à ${nameOfUid(replyingTo.from)}`;
  $('replyText').textContent = replyingTo.text;
}
$('replyCancel').addEventListener('click', () => { cancelReply(); textarea.focus(); });

const messagesBox = $('messages');
let pressTimer = null;
let pressStart = null;
let suppressClick = false;
let swipe = null; // glisser vers la droite pour répondre (téléphone)

messagesBox.addEventListener('click', (e) => {
  // Après un appui long, on n'ouvre pas la photo / le lien qui était sous le doigt
  if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); return; }
  const quote = e.target.closest('.quote');
  if (quote) { e.preventDefault(); jumpToMessage(quote.dataset.target); return; }
  const img = e.target.closest('.bubble img');
  if (img) { e.preventDefault(); openViewer(img.src, img.alt); return; }
  const reply = e.target.closest('.reply-btn');
  if (reply) { startReply(reply.closest('.bubble').dataset.id); return; }
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
  if (!bubble || e.target.closest('video, audio, .reacts, .msg-actions')) return;
  pressStart = { x: e.clientX, y: e.clientY };
  swipe = { bubble, x: e.clientX, y: e.clientY, dx: 0, active: false };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    pressTimer = null;
    swipe = null;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 600);
    navigator.vibrate?.(12);
    openReactPicker(bubble);
  }, 450);
});
const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
const SWIPE_REPLY = 55; // px à glisser pour répondre

function endSwipe(doReply) {
  const s = swipe;
  swipe = null;
  if (!s?.active) return;
  const b = s.bubble;
  b.classList.add('swipe-back');
  b.classList.remove('swiping', 'swipe-ready');
  b.style.transform = '';
  setTimeout(() => b.classList.remove('swipe-back'), 200);
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 400);
  if (doReply && s.dx >= SWIPE_REPLY) startReply(b.dataset.id);
}

messagesBox.addEventListener('pointerup', () => { cancelPress(); endSwipe(true); });
messagesBox.addEventListener('pointercancel', () => { cancelPress(); endSwipe(false); });
messagesBox.addEventListener('pointermove', (e) => {
  if (pressTimer && pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) cancelPress();
  if (!swipe) return;
  const dx = e.clientX - swipe.x;
  const dy = e.clientY - swipe.y;
  if (!swipe.active) {
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { swipe = null; return; } // on fait défiler
    if (dx < 12 || dx < Math.abs(dy) * 1.5) return;
    const c = chats.find((x) => x.id === openChatId);
    if (!c?.accepted) { swipe = null; return; }
    swipe.active = true;
    swipe.bubble.classList.add('swiping');
    closeReactPicker();
  }
  swipe.dx = Math.max(0, Math.min(dx, 80));
  swipe.bubble.style.transform = `translateX(${swipe.dx}px)`;
  const ready = swipe.dx >= SWIPE_REPLY;
  if (ready && !swipe.bubble.classList.contains('swipe-ready')) navigator.vibrate?.(8);
  swipe.bubble.classList.toggle('swipe-ready', ready);
});
// Sur téléphone, l'appui long ouvre les emojis au lieu du menu du navigateur
messagesBox.addEventListener('contextmenu', (e) => {
  if (matchMedia('(pointer: coarse)').matches && e.target.closest('.bubble')) e.preventDefault();
});

document.addEventListener('pointerdown', (e) => {
  if (!reactPicker.hidden && !reactPicker.contains(e.target) && !e.target.closest('.msg-actions, .reacts')) closeReactPicker();
});
messagesBox.addEventListener('scroll', closeReactPicker);
window.addEventListener('resize', closeReactPicker);

// Envoie un fichier : d'abord dans Firebase Storage, puis un message qui pointe dessus
let currentUpload = null;
let uploadCanceled = false;

function showUpload(text, pct) {
  $('uploadBar').hidden = false;
  $('uploadLabel').textContent = text;
  if (pct == null) $('uploadProgress').removeAttribute('value'); // barre qui "attend"
  else $('uploadProgress').value = pct;
}

async function sendFiles(files) {
  const list = [...files];
  if (!list.length || !openChatId) return;
  const c = chats.find((x) => x.id === openChatId);
  if (!c?.accepted) return;
  const chatId = openChatId;
  const reply = replyingTo; // la réponse va avec le premier fichier
  cancelReply();
  uploadCanceled = false;
  for (let i = 0; i < list.length && !uploadCanceled; i++) {
    const prefix = list.length > 1 ? `(${i + 1}/${list.length}) ` : '';
    const r = i === 0 ? reply : null;
    // Les photos vont directement dans le message ; le reste passe par Firebase Storage
    if (fileKind(list[i].type || '') === 'image' && await sendPhoto(chatId, list[i], prefix, r)) continue;
    await sendOneFile(chatId, list[i], prefix, r);
  }
  currentUpload = null;
  $('uploadBar').hidden = true;
}

// ---------- Photos sans Firebase Storage ----------
// La photo est réduite (1600 px max, JPEG) pour tenir dans un message Firestore (< 1 Mo).
const PHOTO_MAX_SIDE = 1600;
const PHOTO_MAX_CHARS = 850000; // taille max du texte "data:image/..." (la règle accepte 900 000)

function readAsDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// Renvoie { data, w, h } ou lance une erreur si le navigateur ne sait pas lire l'image (ex. HEIC)
async function shrinkPhoto(file) {
  const bmp = await createImageBitmap(file); // tourne la photo dans le bon sens tout seul
  try {
    // Petit GIF : on le garde tel quel, sinon il ne bougerait plus
    if (file.type === 'image/gif' && file.size * 1.37 < PHOTO_MAX_CHARS) {
      return { data: await readAsDataURL(file), w: bmp.width, h: bmp.height };
    }
    let side = PHOTO_MAX_SIDE;
    let quality = 0.85;
    for (let tries = 0; tries < 8; tries++) {
      const scale = Math.min(1, side / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; // les parties transparentes deviennent blanches (le JPEG n'a pas de transparence)
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0, w, h);
      const data = canvas.toDataURL('image/jpeg', quality);
      if (data.length <= PHOTO_MAX_CHARS) return { data, w, h };
      if (quality > 0.6) quality -= 0.1;
      else side = Math.round(side * 0.75);
    }
    throw new Error('photo trop lourde');
  } finally {
    bmp.close?.();
  }
}

// Renvoie true si c'est fait (ou si l'erreur a déjà été affichée), false pour essayer en fichier
async function sendPhoto(chatId, file, prefix, reply) {
  const name = (file.name || 'photo').slice(0, 200);
  showUpload(`${prefix}Préparation de la photo…`, null);
  let photo;
  try {
    photo = await shrinkPhoto(file);
  } catch (err) {
    console.warn('photo', err);
    return false; // format inconnu du navigateur : on l'envoie comme un fichier
  }
  if (uploadCanceled) return true;
  showUpload(`${prefix}Envoi de la photo…`, null);
  try {
    const batch = writeBatch(db);
    const data = { from: me.uid, text: '', at: serverTimestamp(), image: { ...photo, name } };
    if (reply) data.replyTo = reply;
    batch.set(doc(collection(db, 'chats', chatId, 'messages')), data);
    batch.update(doc(db, 'chats', chatId), { lastAt: serverTimestamp(), lastText: '📷 Photo', lastFrom: me.uid });
    await batch.commit();
  } catch (err) {
    console.error(err);
    toast(`La photo « ${name} » n’a pas pu être envoyée. Réessaie.`);
  }
  return true;
}

// ---------- Voir une photo en grand ----------
const viewer = $('viewer');
function openViewer(src, name) {
  $('viewerImg').src = src;
  $('viewerImg').alt = name || 'Photo';
  const save = $('viewerSave');
  save.href = src;
  // Une photo rangée dans le message s'enregistre en .jpg (ou .gif…)
  const ext = src.startsWith('data:image/') ? src.slice(11, src.indexOf(';')).replace('jpeg', 'jpg') : '';
  save.download = ext ? (name || 'photo').replace(/\.[a-z0-9]+$/i, '') + '.' + ext : (name || '');
  viewer.showModal();
}
$('viewerClose').addEventListener('click', () => viewer.close());
viewer.addEventListener('click', (e) => { if (e.target === viewer || e.target.id === 'viewerImg') viewer.close(); });
viewer.addEventListener('close', () => { $('viewerImg').removeAttribute('src'); });

async function sendOneFile(chatId, file, prefix, reply) {
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
    const data = { from: me.uid, text: '', at: serverTimestamp(), file: fileInfo };
    if (reply) data.replyTo = reply;
    batch.set(msgRef, data);
    batch.update(doc(db, 'chats', chatId), {
      lastAt: serverTimestamp(),
      lastText: fileLabel(fileInfo),
      lastFrom: me.uid,
    });
    await batch.commit();
  } catch (err) {
    if (err.code === 'storage/canceled') { uploadCanceled = true; toast('Envoi annulé.'); return; }
    console.error(err);
    // Firebase Storage pas activé sur le projet : seules les photos passent
    toast(/^storage\/(unauthorized|unknown|bucket-not-found|project-not-found)$/.test(err.code || '')
      ? `Pour l’instant on peut envoyer des photos, mais pas « ${name} » (vidéos et fichiers pas encore possibles).`
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
  const reply = replyingTo;
  textarea.value = '';
  autoGrow();
  cancelReply();
  try {
    const batch = writeBatch(db);
    const data = { from: me.uid, text, at: serverTimestamp() };
    if (reply) data.replyTo = reply;
    batch.set(doc(collection(db, 'chats', chatId, 'messages')), data);
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
    if (reply && openChatId === chatId) { replyingTo = reply; paintReplyBar(); }
    toast('Message pas envoyé. Réessaie.');
  }
});

// ---------- Groupes : discuter à plusieurs ----------
const groupDialog = $('groupDialog');
const GROUP_MAX = 20;
const ICON_USERS = '<svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/></svg>';

function friendChats() { return chats.filter((c) => c.accepted && !isGroup(c)); }

function mk(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Liste d'amis à cocher (sans ceux qui sont déjà dans le groupe)
function friendPicker(exclude = new Set()) {
  const list = mk('div', 'pick-list');
  const friends = friendChats()
    .map((c) => ({ uid: otherUid(c), name: otherName(c) }))
    .filter((f) => !exclude.has(f.uid))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  for (const f of friends) {
    const row = mk('label', 'pick-row');
    const av = mk('span', 'avatar'); paintAvatar(av, f.name);
    if (isOnline(f.uid)) av.classList.add('online');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = f.uid;
    row.append(av, mk('span', 'pick-name', f.name), box);
    list.append(row);
  }
  return { el: list, count: friends.length, selected: () => [...list.querySelectorAll('input:checked')].map((i) => i.value) };
}

function openGroupDialog(title, bodyParts, footParts) {
  $('groupTitle').textContent = title;
  $('groupBody').replaceChildren(...bodyParts);
  $('groupFoot').replaceChildren(...footParts);
  if (!groupDialog.open) groupDialog.showModal();
}

// Créer un nouveau groupe
function openNewGroup() {
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = 40;
  nameInput.placeholder = 'ex. Les copains du collège';
  nameInput.setAttribute('aria-label', 'Nom du groupe');
  const picker = friendPicker();
  const msg = mk('p', 'msg');
  const body = [mk('h3', '', 'Nom du groupe'), nameInput, mk('h3', '', 'Qui ajouter ?')];
  if (picker.count >= 2) body.push(mk('p', 'settings-note', 'Choisis au moins 2 amis.'), picker.el);
  else body.push(mk('p', 'settings-note', 'Il te faut au moins 2 amis pour créer un groupe. Ajoute-les d’abord dans « Tout le monde ».'));
  body.push(msg);

  const cancel = mk('button', 'btn ghost small', 'Annuler'); cancel.type = 'button';
  cancel.onclick = () => groupDialog.close();
  const create = mk('button', 'btn primary small', 'Créer le groupe'); create.type = 'button';
  create.disabled = picker.count < 2;
  create.onclick = async () => {
    const title = nameInput.value.trim().replace(/\s+/g, ' ');
    const uids = picker.selected();
    if (!title) { setMsg(msg, 'Donne un nom au groupe.'); nameInput.focus(); return; }
    if (uids.length < 2) { setMsg(msg, 'Choisis au moins 2 amis.'); return; }
    if (uids.length + 1 > GROUP_MAX) { setMsg(msg, `${GROUP_MAX} personnes maximum dans un groupe.`); return; }
    create.disabled = true;
    setMsg(msg, '');
    try {
      const id = 'g_' + doc(collection(db, 'chats')).id;
      await setDoc(doc(db, 'chats', id), {
        group: true,
        title,
        members: [me.uid, ...uids],
        createdBy: me.uid,
        accepted: true,
        createdAt: serverTimestamp(),
        lastAt: serverTimestamp(),
        lastText: '',
        lastFrom: '',
      });
      groupDialog.close();
      openChat(id);
      toast(`Groupe « ${title} » créé !`);
    } catch (err) {
      console.error(err);
      create.disabled = false;
      setMsg(msg, 'Impossible de créer le groupe. Réessaie.');
    }
  };
  openGroupDialog('Nouveau groupe', body, [cancel, create]);
  nameInput.focus();
}

// Infos d'un groupe : renommer, voir les membres, ajouter des amis, quitter
function openGroupInfo(chatId) {
  const c = chats.find((x) => x.id === chatId);
  if (!isGroup(c)) return;
  const msg = mk('p', 'msg');

  // Renommer
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = 40;
  nameInput.value = c.title || '';
  nameInput.setAttribute('aria-label', 'Nom du groupe');
  const rename = mk('button', 'btn ghost small', 'Renommer'); rename.type = 'button';
  rename.onclick = async () => {
    const title = nameInput.value.trim().replace(/\s+/g, ' ');
    if (!title) { setMsg(msg, 'Le nom ne peut pas être vide.'); return; }
    if (title === c.title) return;
    try {
      await updateDoc(doc(db, 'chats', c.id), { title });
      toast('Groupe renommé.');
    } catch (err) { console.error(err); setMsg(msg, 'Impossible de renommer le groupe.'); }
  };
  nameInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); rename.click(); } };
  const nameRow = mk('div', 'inline-row'); nameRow.append(nameInput, rename);

  // Membres
  const members = mk('ul', 'list member-list');
  const sorted = [...c.members].sort((a, b) => (a === me.uid ? -1 : b === me.uid ? 1 : userName(a).localeCompare(userName(b), 'fr')));
  for (const uid of sorted) {
    const li = mk('li', 'member');
    const av = mk('span', 'avatar'); paintAvatar(av, userName(uid));
    if (uid !== me.uid && isOnline(uid)) av.classList.add('online');
    const info = mk('div', 'info', uid === me.uid ? `${me.username} (toi)` : userName(uid));
    li.append(av, info);
    if (uid === c.createdBy) li.append(mk('span', 'tag', 'a créé le groupe'));
    members.append(li);
  }

  // Ajouter des amis
  const picker = friendPicker(new Set(c.members));
  const add = mk('button', 'btn primary small', 'Ajouter au groupe'); add.type = 'button';
  add.onclick = async () => {
    const uids = picker.selected();
    if (!uids.length) { setMsg(msg, 'Coche les amis à ajouter.'); return; }
    if (c.members.length + uids.length > GROUP_MAX) { setMsg(msg, `${GROUP_MAX} personnes maximum dans un groupe.`); return; }
    add.disabled = true;
    try {
      await updateDoc(doc(db, 'chats', c.id), { members: arrayUnion(...uids) });
      toast(uids.length > 1 ? 'Amis ajoutés au groupe !' : 'Ami ajouté au groupe !');
      openGroupInfo(c.id); // on remet la liste à jour
    } catch (err) {
      console.error(err);
      add.disabled = false;
      setMsg(msg, 'Impossible d’ajouter ces amis.');
    }
  };

  const body = [
    mk('h3', '', 'Nom du groupe'), nameRow,
    mk('h3', '', `Membres (${c.members.length})`), members,
    mk('h3', '', 'Ajouter des amis'),
  ];
  if (picker.count) body.push(picker.el, add);
  else body.push(mk('p', 'settings-note', friendChats().length ? 'Tous tes amis sont déjà dans le groupe.' : 'Ajoute d’abord des amis.'));
  body.push(msg);

  const leave = mk('button', 'btn danger small', 'Quitter le groupe'); leave.type = 'button';
  leave.onclick = () => leaveGroup(c);
  const foot = [leave];
  if (c.createdBy === me.uid) {
    const del = mk('button', 'btn danger small', 'Supprimer le groupe'); del.type = 'button';
    del.onclick = () => deleteGroup(c);
    foot.push(del);
  }
  openGroupDialog(c.title || 'Groupe', body, foot);
}

async function leaveGroup(c) {
  const last = c.members.length <= 1;
  if (!confirm(last
    ? `Quitter « ${chatTitle(c)} » ? Tu es le dernier membre : le groupe sera supprimé.`
    : `Quitter « ${chatTitle(c)} » ? Tu ne verras plus les messages du groupe.`)) return;
  groupDialog.close();
  if (openChatId === c.id) closeChat();
  try {
    if (last) await deleteDoc(doc(db, 'chats', c.id));
    else await updateDoc(doc(db, 'chats', c.id), { members: arrayRemove(me.uid) });
    toast(`Tu as quitté « ${chatTitle(c)} ».`);
  } catch (err) {
    console.error(err);
    toast('Impossible de quitter le groupe pour le moment.');
  }
}

async function deleteGroup(c) {
  if (!confirm(`Supprimer « ${chatTitle(c)} » ? Le groupe et ses messages disparaîtront pour tout le monde.`)) return;
  groupDialog.close();
  if (openChatId === c.id) closeChat();
  try {
    await deleteDoc(doc(db, 'chats', c.id));
    toast('Groupe supprimé.');
  } catch (err) {
    console.error(err);
    toast('Impossible de supprimer le groupe.');
  }
}

$('newGroupBtn').addEventListener('click', openNewGroup);
$('groupBtn').addEventListener('click', () => openGroupInfo(openChatId));
$('chatHeadInfo').addEventListener('click', () => openGroupInfo(openChatId));
$('groupClose').addEventListener('click', () => groupDialog.close());
groupDialog.addEventListener('click', (e) => { if (e.target === groupDialog) groupDialog.close(); });

$('backBtn').addEventListener('click', closeChat);
$('removeBtn').addEventListener('click', () => {
  const c = chats.find((x) => x.id === openChatId);
  if (c) removeChat(c, true);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!reactPicker.hidden) { closeReactPicker(); return; }
  if (document.querySelector('dialog[open]')) return; // Échap ferme d'abord la fenêtre ouverte
  if (replyingTo && openChatId) { cancelReply(); return; }
  if (openChatId) closeChat();
});

// ---------- Qui est en ligne ? (Firebase Realtime Database : status/{uid}) ----------
// Quand l'onglet se ferme ou que le réseau coupe, Firebase nous passe "hors ligne" tout seul.
let unsubConnected = null;
let unsubOffset = null;
let awayTimer = null;
let serverOffset = 0;              // écart entre l'horloge de l'ordi et celle de Firebase
const friendStatus = new Map();    // uid -> { online, lastSeen }
const statusSubs = new Map();      // uid -> arrêter d'écouter

function myStatusRef() { return dbRef(rtdb, `status/${me.uid}`); }
function setMyStatus(online) {
  if (!me) return Promise.resolve();
  return dbSet(myStatusRef(), { online, lastSeen: dbNow() }).catch((err) => console.error('présence', err));
}

function startPresence() {
  unsubOffset = onValue(dbRef(rtdb, '.info/serverTimeOffset'), (s) => { serverOffset = s.val() || 0; });
  unsubConnected = onValue(dbRef(rtdb, '.info/connected'), async (snap) => {
    if (snap.val() !== true || !me) return;
    try {
      await onDisconnect(myStatusRef()).set({ online: false, lastSeen: dbNow() });
      await setMyStatus(true);
      if (document.visibilityState !== 'visible') goAwaySoon();
    } catch (err) { console.error('présence', err); }
  });
}

// Onglet caché pendant 2 minutes = plus "en ligne"
function goAwaySoon() {
  clearTimeout(awayTimer);
  awayTimer = setTimeout(() => setMyStatus(false), 2 * 60 * 1000);
}
document.addEventListener('visibilitychange', () => {
  if (!me) return;
  if (document.visibilityState === 'visible') { clearTimeout(awayTimer); setMyStatus(true); }
  else goAwaySoon();
});

function stopPresence() {
  unsubConnected?.(); unsubConnected = null;
  unsubOffset?.(); unsubOffset = null;
  clearTimeout(awayTimer);
  statusSubs.forEach((stop) => stop());
  statusSubs.clear();
  friendStatus.clear();
}

// Écoute le statut de chaque ami (et arrête pour ceux qui ne le sont plus)
function syncFriendStatus() {
  const uids = new Set(chats.filter((c) => c.accepted && !isGroup(c)).map(otherUid));
  for (const [uid, stop] of statusSubs) {
    if (!uids.has(uid)) { stop(); statusSubs.delete(uid); friendStatus.delete(uid); }
  }
  for (const uid of uids) {
    if (statusSubs.has(uid)) continue;
    statusSubs.set(uid, onValue(dbRef(rtdb, `status/${uid}`), (s) => {
      friendStatus.set(uid, s.val());
      renderLists();
      paintChatStatus();
    }, (err) => console.error('statut', err)));
  }
}

function isOnline(uid) { return !!friendStatus.get(uid)?.online; }

function statusText(uid) {
  const s = friendStatus.get(uid);
  if (!s) return '';
  if (s.online) return 'En ligne';
  if (!s.lastSeen) return 'Hors ligne';
  const min = Math.floor((Date.now() + serverOffset - s.lastSeen) / 60000);
  if (min < 1) return 'Actif à l’instant';
  if (min < 60) return `Actif il y a ${min} min`;
  const d = new Date(s.lastSeen);
  if (d.toDateString() === new Date().toDateString()) return `Actif aujourd’hui à ${hhmm(d)}`;
  return `Actif ${dayLabel(d).toLowerCase()} à ${hhmm(d)}`;
}

// "En ligne" / "Actif il y a 5 min" sous le nom, en haut de la conversation
function paintChatStatus() {
  const c = chats.find((x) => x.id === openChatId);
  const el = $('chatStatus');
  if (!c) { el.textContent = ''; return; }
  if (isGroup(c)) {
    // Groupe : la liste des membres (et combien d'amis sont en ligne)
    const others = c.members.filter((u) => u !== me.uid).map(userName).sort((a, b) => a.localeCompare(b, 'fr'));
    const online = c.members.filter((u) => u !== me.uid && isOnline(u)).length;
    el.textContent = (others.length ? others.join(', ') + ' et toi' : 'Il ne reste que toi')
      + (online ? ` · ${online} en ligne` : '');
    el.classList.remove('online');
    $('chatAvatar').classList.remove('online');
    return;
  }
  const uid = otherUid(c);
  el.textContent = c.accepted ? statusText(uid) : '';
  el.classList.toggle('online', isOnline(uid));
  $('chatAvatar').classList.toggle('online', isOnline(uid));
}
setInterval(paintChatStatus, 30000);

// ---------- Notifications quand un ami t'écrit ----------
const canNotify = 'Notification' in window;
let swReg = null;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then((r) => { swReg = r; }).catch((err) => console.warn('sw', err));
  // Clic sur une notification : le service worker nous dit quelle conversation ouvrir
  navigator.serviceWorker.onmessage = (e) => { if (e.data?.openChat && me) openChat(e.data.openChat); };
}

function notifPref() { try { return localStorage.getItem('papote_notif') || 'on'; } catch { return 'on'; } }
function setNotifPref(v) { try { localStorage.setItem('papote_notif', v); } catch {} refreshNotifUI(); }
function bannerDismissed() { try { return localStorage.getItem('papote_notif_banner') === 'no'; } catch { return false; } }

function refreshNotifUI() {
  const perm = canNotify ? Notification.permission : 'unsupported';
  const pref = notifPref();
  $('notifBanner').hidden = !(perm === 'default' && pref === 'on' && !bannerDismissed());
  document.querySelectorAll('#notifChoice [data-notif]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.notif === pref)));
  let note = 'Tu es prévenu quand un ami t’écrit, tant que Papote est ouvert dans un onglet (même caché).';
  if (pref === 'off') note = 'Plus de son ni de notification. Les nouveaux messages restent marqués d’un point.';
  else if (perm === 'unsupported') note = 'Ton navigateur ne sait pas afficher de notifications : tu auras un son et un message en bas de l’écran.';
  else if (perm === 'denied') note = 'Ton navigateur bloque les notifications de ce site : autorise-les avec le cadenas à côté de l’adresse.';
  else if (perm === 'default') note = 'Ton navigateur va te demander l’autorisation.';
  $('notifNote').textContent = note;
}

async function askNotifPermission() {
  if (!canNotify) return;
  try { await Notification.requestPermission(); } catch {}
  refreshNotifUI();
  if (Notification.permission === 'granted') toast('Notifications activées 🔔');
  else if (Notification.permission === 'denied') toast('Notifications refusées. Tu peux changer ça dans les réglages du navigateur.');
}
$('notifEnable').addEventListener('click', askNotifPermission);
$('notifDismiss').addEventListener('click', () => {
  try { localStorage.setItem('papote_notif_banner', 'no'); } catch {}
  refreshNotifUI();
});
document.querySelectorAll('#notifChoice [data-notif]').forEach((b) => b.addEventListener('click', () => {
  setNotifPref(b.dataset.notif);
  if (b.dataset.notif === 'on' && canNotify && Notification.permission === 'default') askNotifPermission();
}));

// Petit "ding" (le navigateur n'autorise le son qu'après un premier clic sur la page)
let audioCtx = null;
function audio() {
  try { audioCtx ||= new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}
document.addEventListener('pointerdown', audio, { once: true });
function playDing() {
  const ctx = audio();
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime;
  for (const [freq, delay] of [[880, 0], [1320, 0.1]]) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t + delay);
    g.gain.exponentialRampToValueAtTime(0.12, t + delay + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.25);
    o.connect(g).connect(ctx.destination);
    o.start(t + delay);
    o.stop(t + delay + 0.3);
  }
}

async function showNotif(title, body, chatId) {
  const focused = document.visibilityState === 'visible' && document.hasFocus();
  if (focused || !canNotify || Notification.permission !== 'granted') { toast(`${title} : ${body}`); return; }
  const opts = { body, tag: chatId || 'papote', renotify: true, data: { chatId } };
  try {
    if (swReg) { await swReg.showNotification(title, opts); return; }
    const n = new Notification(title, opts);
    n.onclick = () => { window.focus(); if (chatId) openChat(chatId); n.close(); };
  } catch (err) {
    console.warn('notification', err);
    toast(`${title} : ${body}`);
  }
}

// Appelé par listenChats pour chaque conversation qui change
let chatsLoaded = false;
const knownLastAt = new Map();
function checkForNews(snap) {
  for (const ch of snap.docChanges()) {
    const id = ch.doc.id;
    if (ch.type === 'removed') { knownLastAt.delete(id); continue; }
    const c = { id, ...ch.doc.data({ serverTimestamps: 'estimate' }) };
    const at = toDate(c.lastAt).getTime();
    const prev = knownLastAt.get(id);
    knownLastAt.set(id, at);
    if (!chatsLoaded || ch.doc.metadata.hasPendingWrites || notifPref() === 'off') continue;

    if (ch.type === 'added' && isGroup(c)) {
      if (c.createdBy === me.uid) continue;
      playDing();
      showNotif('Nouveau groupe', `Tu as été ajouté au groupe « ${chatTitle(c)} »`, id);
    } else if (ch.type === 'added' && !c.accepted && c.requestedBy !== me.uid) {
      playDing();
      showNotif('Nouvelle demande d’ami', `${otherName(c)} veut être ton ami`, null);
    } else if (c.accepted && c.lastText && c.lastFrom && c.lastFrom !== me.uid && prev !== undefined && at > prev) {
      // Pas besoin de prévenir si tu as déjà la conversation sous les yeux
      const watching = openChatId === id && document.visibilityState === 'visible' && document.hasFocus();
      if (watching) continue;
      playDing();
      if (isGroup(c)) showNotif(chatTitle(c), `${userName(c.lastFrom)} : ${c.lastText}`, id);
      else showNotif(otherName(c), c.lastText, id);
    }
  }
  chatsLoaded = true;
}

refreshNotifUI();

// ---------- Installer Papote comme une application ----------
// Chrome, Edge (ordi + Android) : le navigateur nous donne un "beforeinstallprompt" qu'on garde
// pour afficher notre propre bouton "Installer". iPhone : il faut passer par Partager > Écran d'accueil.
let installEvt = window.__papoteInstall || null; // attrapé tôt par theme-boot.js
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function isInstalled() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}
function installBannerDismissed() { try { return localStorage.getItem('papote_install_banner') === 'no'; } catch { return false; } }

function refreshInstallUI() {
  const installed = isInstalled();
  const canPrompt = !!installEvt && !installed;
  $('installBanner').hidden = installed || installBannerDismissed() || !(canPrompt || isIOS);
  $('installBannerBtn').hidden = !canPrompt;
  $('installBannerText').textContent = canPrompt
    ? 'Installe Papote sur ton appareil, comme une vraie appli.'
    : 'Installe Papote : touche Partager (carré avec une flèche) puis « Sur l’écran d’accueil ».';
  $('installBtn').hidden = !canPrompt;
  let note;
  if (installed) note = 'Papote est installé sur cet appareil ✓';
  else if (canPrompt) note = 'Une icône Papote sur ton écran, qui s’ouvre en plein écran sans barre d’adresse.';
  else if (isIOS) note = 'Sur iPhone / iPad : ouvre Papote dans Safari, touche le bouton Partager (carré avec une flèche), puis « Sur l’écran d’accueil ».';
  else note = 'Dans Chrome ou Edge : menu ⋮ puis « Installer Papote » (sur Android : « Ajouter à l’écran d’accueil »).';
  $('installNote').textContent = note;
}

async function doInstall() {
  if (!installEvt) return;
  const evt = installEvt;
  installEvt = null; // il ne sert qu'une fois
  evt.prompt();
  try { await evt.userChoice; } catch {}
  refreshInstallUI();
}

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; refreshInstallUI(); });
window.addEventListener('appinstalled', () => { installEvt = null; toast('Papote est installé ! 🎉'); refreshInstallUI(); });
$('installBtn').addEventListener('click', doInstall);
$('installBannerBtn').addEventListener('click', doInstall);
$('installDismiss').addEventListener('click', () => {
  try { localStorage.setItem('papote_install_banner', 'no'); } catch {}
  refreshInstallUI();
});
refreshInstallUI();

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
