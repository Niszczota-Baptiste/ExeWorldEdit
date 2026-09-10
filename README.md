# Titi WorldEdit

Éditeur de mondes Minecraft pour Windows. Ouvre une save ou un `.mca`, transforme
le build (miroir, rotation, remplacement, terrain, brushs…), réexporte — sans
jamais toucher au fichier d'origine.

Bâti sur le moteur WorldEdit du site `titisite`, extrait ici en package
autonome. Cible : Minecraft **vanilla 1.18**, blocs custom `minefield:*`
préservés.

## Le dépôt

| | |
|---|---|
| `packages/we-engine` | Le moteur : Anvil lossless, ~30 opérations, formats d'échange, staging non destructif. Aucune dépendance à un serveur ou un navigateur. |
| `apps/desktop` | L'application Electron. Phase 2. |

## Démarrer

```bash
npm install
npm test
npm run lint
```

## Ce qui marche aujourd'hui

Le moteur est extrait, débranché de toute base de données, et couvert par
129 tests : round-trip Anvil lossless, table des états de blocs, staging avec
undo/redo, export `.mca` et `.zip`, formats `.schem` et `.litematic`,
bibliothèque de schematics.

L'application, elle, n'existe pas encore.

## Documentation

- `docs/desktop.md` — architecture, `StorageAdapter`, écarts assumés avec le
  moteur du site, limites connues, état des phases.
- `CLAUDE.md` — invariants et conventions.
