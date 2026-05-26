# Documentation du scan et du score

Cette application ne dit pas avec certitude qu'un compte est fake ou reel. Elle calcule un score de credibilite a partir de signaux publics recuperables automatiquement.

## Donnees saisies

L'utilisateur donne seulement:

- `displayName`: nom du compte, exemple `Gaby`
- `username`: pseudo, exemple `@gabbybunnyy`
- `platform`: reseau de depart, exemple `tiktok`

Le backend nettoie ces valeurs:

- retire le `@` du pseudo
- limite les caracteres dangereux
- normalise le reseau (`twitter` devient `x`, `yt` devient `youtube`, etc.)

## Etapes du scan

### 1. Scan du reseau de depart

Le serveur construit l'URL du profil:

- TikTok: `https://www.tiktok.com/@pseudo`
- Instagram: `https://www.instagram.com/pseudo/`
- X: `https://x.com/pseudo`
- YouTube: `https://www.youtube.com/@pseudo`

Il appelle ensuite la page avec Axios, un User-Agent navigateur, un timeout, des redirects et un cache de 10 minutes.

### 2. Extraction des signaux publics

Le HTML est analyse avec Cheerio. Le serveur cherche:

- le titre de page
- la meta description
- les scripts JSON integres par les plateformes
- le pseudo dans les donnees publiques
- le nom du compte dans les donnees publiques
- la bio
- l'avatar
- les stats publiques: followers, following, likes, publications
- les dates de creation/publication detectables
- les emails publics
- les liens externes
- les liens vers d'autres reseaux
- les liens de type Linktree, Beacons, bio.site, Carrd, etc.

Les scripts JSON sont parcourus pour retrouver des objets qui ressemblent a un profil utilisateur. Le candidat le plus coherent est choisi selon:

- pseudo exact retrouve
- nom visible
- bio visible
- statistiques presentes
- lien externe present

### 3. Classification de la page

Chaque plateforme recoit un statut:

- `found`: profil confirme
- `not_found`: profil absent ou page 404
- `blocked`: captcha, rate limit, acces refuse ou anti-bot
- `unknown`: page accessible mais pas assez informative
- `error`: erreur reseau ou HTTP non exploitable

Une page est consideree comme trouvee si:

- le pseudo est retrouve dans les donnees publiques, ou
- des stats significatives sont detectees: followers, likes ou publications

Cas particulier: si une plateforme affiche des signaux anti-bot mais que le profil contient quand meme le pseudo et des stats, le profil est garde comme `found`, avec une confiance moyenne.

### 4. Inspection des liens externes

Si le profil contient des liens externes, le serveur inspecte jusqu'a 3 liens.

Pour chaque lien externe, il cherche:

- emails
- nouveaux liens vers Instagram, X, TikTok ou YouTube
- autres liens publics

Cela permet de trouver un Linktree-like ou un hub perso qui pointe vers d'autres reseaux.

### 5. Recoupement multi-reseaux

Le serveur verifie ensuite les autres plateformes.

Priorite:

1. utiliser les liens sociaux trouves dans la bio ou le lien externe
2. sinon tester le meme pseudo sur Instagram, X, TikTok et YouTube

Exemple: si le scan part de TikTok avec `@gabbybunnyy`, le serveur teste aussi:

- `https://www.instagram.com/gabbybunnyy/`
- `https://x.com/gabbybunnyy`
- `https://www.youtube.com/@gabbybunnyy`

## Calcul du score de credibilite

Le score commence a `0`, puis on ajoute ou retire des points selon les signaux.

### Signaux positifs

| Signal | Points |
| --- | ---: |
| Profil de depart trouve | `+25` |
| Pseudo retrouve dans les donnees publiques | `+12` |
| Nom saisi coherent avec le profil | `+10` |
| Statistiques publiques recuperees | `+12` |
| Followers detectes | `+6` |
| 20 publications ou plus | `+10` |
| 3 a 19 publications | `+5` |
| Likes globaux coherents avec l'audience | `+8` |
| Activite detectee dans les 45 derniers jours | `+10` |
| Activite detectee dans les 180 derniers jours | `+5` |
| Email public detecte | `+8` |
| Lien bio / hub externe detecte | `+7` |
| Liens vers d'autres reseaux detectes | `+8` |
| Autre reseau confirme | `+9` par reseau, maximum `+18` |

### Signaux negatifs

| Signal | Points |
| --- | ---: |
| Profil de depart introuvable | `-25` |
| Nom saisi non retrouve clairement alors qu'un profil existe | `-5` |
| Beaucoup de followers avec tres peu de contenu | `-12` |
| Ratio likes/followers suspect | `-15` |
| Pseudo absent de plusieurs plateformes testees | `-12` |

### Signaux neutres

Certains signaux ne changent pas le score mais sont affiches pour expliquer les limites:

- plateforme bloquee
- donnees masquees
- page accessible mais non exploitable
- profil de depart non confirme automatiquement

## Conversion en pourcentage

Apres addition des points:

```text
score final = score borne entre 0 et 100
```

Donc:

- score negatif => `0%`
- score au-dessus de 100 => `100%`
- sinon le total devient le pourcentage affiche

## Niveaux affiches

| Score | Niveau |
| ---: | --- |
| `75%` a `100%` | Credibilite forte |
| `50%` a `74%` | Credibilite moyenne |
| `30%` a `49%` | A verifier |
| `0%` a `29%` | Risque eleve |

## Score de confiance

Le score de confiance est different du score de credibilite.

Il indique a quel point l'analyse automatique est exploitable.

Base: `20`.

On ajoute:

- `+25` si le profil de depart est trouve
- `+10` si le profil de depart est introuvable clairement
- `+5` si le profil reste inconnu
- `+20` si des stats publiques sont detectees
- `+10` si le pseudo est retrouve
- `+8` si le nom saisi est retrouve
- `+8` par autre reseau confirme, maximum `+16`
- `+6` si un email est trouve

On retire:

- `-4` par plateforme inconnue/bloquee, maximum `-15`

La confiance finale est bornee entre `10%` et `95%`.

## Exemple concret

Entree:

```json
{
  "displayName": "Gaby",
  "username": "@gabbybunnyy",
  "platform": "tiktok"
}
```

L'application peut recuperer:

- le profil TikTok
- le pseudo dans les donnees publiques
- le nom affiche
- la bio
- les followers
- les likes
- le nombre de publications
- un lien externe
- une presence potentielle sur Instagram ou X

Elle additionne ensuite les facteurs trouves. Si beaucoup de signaux sont coherents, le score monte. Si le profil est absent, incoherent ou pauvre en signaux publics, le score baisse.

## Limites importantes

Le scan reste heuristique.

Instagram, X, TikTok et YouTube peuvent:

- bloquer le scraping
- renvoyer une page de connexion
- renvoyer une page generique
- cacher les stats
- changer leur HTML sans prevenir
- limiter l'IP

Pour un usage pro, il faut brancher une API specialisee ou un navigateur automatise avec proxies, cache, retries et verification humaine.
