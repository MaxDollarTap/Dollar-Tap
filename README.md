# Dollar Tap : serveur + jeu

Ce dossier contient **tout** : le jeu (page web, dans `public/`) et le serveur qui sauvegarde les joueurs et encaisse les paiements PayPal.
Une fois en ligne, tu ouvres l'adresse du serveur sur ton téléphone : c'est le jeu.

## 1. Ce que tu dois créer (une seule fois)

### a) Un bot Telegram (pour jouer dans Telegram)
1. Dans Telegram, ouvre **@BotFather** → `/newbot` → choisis un nom.
2. Copie le **token** (ex. `123456:ABC...`) → variable `BOT_TOKEN`.
3. Plus tard (étape 4) : `/newapp` ou `/setmenubutton` pour y mettre l'adresse de ton jeu.

### b) Une app PayPal
1. Va sur **developer.paypal.com** → connecte-toi avec ton compte **PayPal Business**.
2. **Apps & Credentials** → mode **Sandbox** → *Create App* (nom : Dollar Tap).
   - Copie **Client ID** → `PAYPAL_CLIENT_ID`
   - Copie **Secret** → `PAYPAL_SECRET`
3. Le webhook se crée **après** l'étape 3 (il faut ton adresse en ligne).

## 2. Mettre le serveur en ligne (exemple : Render)
1. Crée un compte GitHub, un dépôt privé, et mets-y le contenu de ce dossier (sans `.env`).
2. Sur **render.com** → *New* → *Web Service* → choisis ton dépôt.
   - Build Command : `npm install`
   - Start Command : `npm start`
3. **Ajoute un disque persistant** (onglet *Disks*, point de montage `/var/data`).
   Sans disque, la base est **effacée à chaque redémarrage** et tous les joueurs perdent leur progression.
   (Le disque est payant sur Render. Railway et Fly.io proposent aussi des volumes.)
4. Onglet **Environment** : colle tes clés ici (et **nulle part ailleurs**) :

| Variable | Valeur |
|---|---|
| `BASE_URL` | l'adresse de ton service, ex. `https://dollar-tap.onrender.com` (sans `/` final) |
| `BOT_TOKEN` | token de @BotFather |
| `PAYPAL_ENV` | `sandbox` pour tester, `live` pour de vrais paiements |
| `PAYPAL_CLIENT_ID` | Client ID PayPal |
| `PAYPAL_SECRET` | Secret PayPal |
| `PAYPAL_WEBHOOK_ID` | voir étape 3 |
| `DATA_DIR` | `/var/data` |
| `ALLOW_GUESTS` | `1` (jouer depuis un navigateur sans Telegram) ou `0` (Telegram seulement) |

## 3. Le webhook PayPal
1. developer.paypal.com → ton app → **Webhooks** → *Add webhook*.
2. URL : `https://ton-adresse/paypal/webhook`
3. Événement à cocher : **Payment capture completed**.
4. Copie le **Webhook ID** → variable `PAYPAL_WEBHOOK_ID` → redéploie.

## 4. Tester (en Sandbox, avec de faux paiements)
1. Ouvre `https://ton-adresse` sur ton téléphone. Onglet **Premium** : le bandeau « Mode test » a disparu.
2. Achète un pack : tu es envoyé sur PayPal. Connecte-toi avec un **compte acheteur Sandbox** (developer.paypal.com → *Sandbox accounts*).
3. Reviens dans le jeu : les énergies arrivent en quelques secondes. Un 2e clic sur « retour » ne crédite **pas** deux fois.
4. Ferme la page, rouvre-la : la progression est là.

## 5. Passer en vrais paiements
1. Dans developer.paypal.com, passe en mode **Live**, crée une app Live, récupère ses clés.
2. Remplace `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`, crée un **webhook Live**, remplace `PAYPAL_WEBHOOK_ID`, mets `PAYPAL_ENV=live`.
3. Fais un vrai achat de 0,50 € toi-même pour vérifier.

## 6. Ouvrir le jeu dans Telegram
@BotFather → `/newapp` (ou `/setmenubutton`) → choisis ton bot → colle l'adresse `BASE_URL`.

## Où sont les prix ?
Dans `server.js`, objet `CATALOG` (prix en euros). Le jeu **ne peut pas** les modifier.
Les montants d'énergies et les durées de boost sont dans le jeu (`public/index.html`, constante `PACKS`).

## 7. Le bot Telegram (démarrage, bouton « Ouvrir Dollar Tap », notifications, canal)
Au démarrage, le serveur configure **tout seul** le bot (webhook, bouton « Dollar Tap » du menu, commande /start).
Il te faut seulement : `BOT_TOKEN`, `BASE_URL` (en **https**) et `TG_SECRET` (phrase secrète au hasard).

**Ce que voit un joueur**
1. Il envoie /start (ou clique ton lien) → « Choisis une langue » (Français / English).
2. Il reçoit « Tape le dollar… » avec le bouton **▶️ Ouvrir Dollar Tap**.
3. Il reçoit ensuite des messages du bot dans son chat privé, avec le même bouton :
   - 🎉 un ami a rejoint via son lien (récompense d'énergies : +400 au 5ᵉ ami, +60 ensuite) ;
   - 💰 sa commission quotidienne de 5 % sur les gains de ses amis (calculée chaque nuit, **rien n'est retiré aux amis**) ;
   - 🏆 niveau atteint, 🥇 top 10, ✅ paiement reçu, ⚡ énergies rechargées (s'il active l'option dans les paramètres).
   Les messages sont limités (anti-spam). Un joueur ne reçoit rien tant qu'il n'a pas fait /start.

**Son lien d'invitation** (affiché dans le jeu) : `https://t.me/TON_BOT?start=ref_<son identifiant>`. Le bouton « Copier mon lien » ouvre aussi le partage Telegram.

**Poster dans ton canal**
1. Ajoute ton bot comme **administrateur** de ton canal.
2. Renseigne `CHANNEL_ID` et `ADMIN_ID` (ton identifiant : écris à @userinfobot).
3. Écris **/channel** au bot : il publie le message avec le bouton « Jouer / Play » (qui ouvre le bot, puis le jeu).

**Important :** les messages parlent d'énergies et de « $ du jeu » (monnaie virtuelle). Ne mets pas de promesses de gains en euros : ce serait trompeur si aucun paiement réel n'existe.
Pour ajouter d'autres langues aux messages du bot, complète l'objet `TX` dans `server.js`.

## À savoir avant d'ouvrir au public
- **Triche :** le jeu envoie sa progression au serveur, qui la stocke telle quelle. Un joueur technique peut donc modifier son score. Les **paiements**, eux, sont vérifiés par le serveur.
- **Telegram :** sur iPhone et Android, Telegram peut exiger **Telegram Stars** pour les biens numériques dans les Mini Apps. Vérifie les règles actuelles.
- **Pass de saison :** vendu comme un achat unique de 30 jours (pas de renouvellement automatique). L'abonnement récurrent demande PayPal Subscriptions.
- **Légal :** conditions de vente, politique de confidentialité, statut d'entrepreneur, TVA, et frais PayPal (lourds sur 0,50 €).
- **Sauvegardes :** télécharge régulièrement le fichier `dollartap.db` du disque.
