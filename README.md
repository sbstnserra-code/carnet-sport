# Carnet Sport

Application web personnelle de suivi musculation, nutrition et corps. Une page HTML, sans build, hébergée sur GitHub Pages, données par compte dans Supabase (Postgres + Row Level Security).

## Structure

- `index.html` : toute l'application (HTML, CSS, JS)
- `vendor/` : supabase-js et Chart.js (copies locales, l'app marche hors ligne une fois chargée)
- `sw.js`, `manifest.webmanifest`, `icons/` : installation sur l'écran d'accueil (iPhone, Android)
- `supabase/migration_001.sql` : schéma complet (tables `docs` et `profiles`, règles RLS, fonctions d'administration)
- `supabase/functions/ai/` : fonction serveur optionnelle pour l'estimation automatique des repas (nécessite le secret `ANTHROPIC_API_KEY`)

## Données

Chaque compte ne voit et ne modifie que ses propres lignes (`docs.user_id = auth.uid()`). Les administrateurs créent les comptes depuis Réglages > Utilisateurs.

## Contribuer

Modifie `index.html` sur une branche et ouvre une pull request. Pas de dépendances à installer : ouvre le fichier dans un navigateur (les données restent alors dans le navigateur tant que tu n'es pas connecté).
