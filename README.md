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

Projet Firebase : `chat-amis-tl26`. Pour redéployer les règles :

```bash
npx firebase-tools deploy --only firestore --project chat-amis-tl26
```

Tester en local :

```bash
npx serve . -l 5550
```
