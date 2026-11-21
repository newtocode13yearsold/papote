# Papote

Un petit site pour discuter avec ses amis :

1. Crée ton compte avec ton **email**, un **pseudo** et un mot de passe.
2. Ajoute tes amis avec leur pseudo, ou choisis-les dans la liste « Tout le monde » (ils doivent accepter ta demande).
3. Discute avec eux en direct.

## Comment ça marche

- **index.html / style.css / app.js** : le site (pas besoin de build).
- **Firebase Auth** gère les comptes (email + mot de passe).
- **Cloud Firestore** stocke les pseudos, les amitiés et les messages, en temps réel.
- **firestore.rules** : les règles de sécurité. On ne peut lire que ses propres
  conversations, et on ne peut écrire que dans une conversation acceptée par les deux amis.
  L'email n'est jamais visible par les autres, seulement le pseudo.

- **Realtime Database** (`database.rules.json`) : qui est en ligne (`status/{uid}`).
  Quand l'onglet se ferme, Firebase passe la personne « hors ligne » tout seul.
- **sw.js** : service worker pour afficher les notifications de nouveaux messages
  (elles marchent tant que Papote est ouvert dans un onglet) et pour pouvoir
  **installer Papote comme une application** (avec `manifest.webmanifest` et le dossier `icons/`).
  Sur ordi / Android : bouton « Installer » ; sur iPhone : Partager > « Sur l'écran d'accueil ».
- **Photos** : elles sont réduites par le site (1600 px max, JPEG) puis rangées directement
  dans le message Firestore. Pas besoin de Firebase Storage (qui demande un compte payant).
  Les vidéos et autres fichiers passent encore par Storage, qui n'est pas activé.
- **Groupes** : une conversation à plusieurs (3 à 20 personnes) a `group: true`, un `title`
  et un id qui commence par `g_`. Chaque membre peut renommer le groupe, ajouter ses amis
  ou partir ; celui qui l'a créé peut le supprimer.

Projet Firebase : `chat-amis-tl26`. Pour redéployer les règles :

```bash
npx firebase-tools deploy --only firestore,database --project chat-amis-tl26
```

Tester en local :

```bash
npx serve . -l 5550
```
