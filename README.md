# Fake Reel Scanner

Projet Node.js + HTML/JS pour analyser automatiquement un profil createur a partir de trois informations:

- nom du compte, exemple `Gaby`
- pseudo, exemple `@gabbybunnyy`
- reseau de depart, exemple `TikTok`

Le backend tente ensuite de recuperer automatiquement:

- existence du profil de depart
- pseudo et nom detectes
- bio publique
- followers, likes, publications quand la plateforme les expose
- activite recente quand une date publique est disponible
- email public
- liens bio ou Linktree-like
- liens vers d'autres reseaux
- presence du meme pseudo sur Instagram, X, TikTok et YouTube

## Installation

```bash
npm install
```

## Lancement

```bash
npm start
```

Ouvre ensuite `http://localhost:3000`.

## API

La logique de scan et de score est detaillee dans [docs/SCORING.md](docs/SCORING.md).

### POST /api/analyze

```bash
curl -s -X POST http://localhost:3000/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"displayName":"Gaby","username":"@gabbybunnyy","platform":"tiktok"}'
```

### GET compatible

```bash
curl "http://localhost:3000/api/analyze/gabbybunnyy?displayName=Gaby&platform=tiktok"
```

## Limites

Instagram, X, TikTok et YouTube peuvent bloquer les requetes serveur, renvoyer une page de connexion ou demander un captcha. Le score reste heuristique. Pour un niveau pro, branche une API specialisee comme Apify, BrightData, ScrapeCreators ou PhantomBuster, puis ajoute proxies, cache, delais et verification humaine.
