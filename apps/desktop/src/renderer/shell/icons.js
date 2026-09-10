// Icônes utilisées, importées NOMMÉMENT — et le SEUL endroit du renderer qui
// importe `lucide-react`.
//
// `import * as Icons from 'lucide-react'` embarque les ~1500 icônes de la
// bibliothèque : un mégaoctet de bundle pour en afficher une vingtaine, et
// autant de temps de démarrage perdu à chaque lancement. Une nouvelle icône
// s'ajoute ici, jamais dans un composant.
export {
  // Rail d'outils et roue radiale
  BoxSelect, FlipHorizontal2, Blocks, Circle, Mountain, Brush, Spline,
  Type, Waves, Ruler, Library, Square,
  // Coquille
  Pickaxe, Search, Minus, X, Settings2, Layers, Layers3,
  FolderOpen, FolderTree,
  // Actions
  Play, Undo2, Redo2, FileDown, Globe, AlertTriangle, RotateCcw, ChevronDown,
  // Barre d'état
  Gauge, Boxes, Crosshair, MemoryStick, History, ArrowRight,
} from 'lucide-react';
