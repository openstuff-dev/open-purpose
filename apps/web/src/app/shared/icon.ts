import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  input,
} from '@angular/core';
import {
  ArrowRight,
  BookOpen,
  Bot,
  Bug,
  Building2,
  Check,
  ChevronDown,
  ChevronsUpDown,
  CircleUser,
  Copy,
  Eye,
  FileText,
  FolderGit2,
  GitBranch,
  Inbox,
  KeyRound,
  Layers,
  LayoutGrid,
  Link2,
  Lock,
  LockOpen,
  LogOut,
  Map as MapIcon,
  Menu,
  Monitor,
  Moon,
  Network,
  Palette,
  Pencil,
  Plug,
  Plus,
  Search,
  Server,
  Settings,
  Share2,
  Sun,
  Trash2,
  Users,
  X,
  MessageSquare,
  History,
  CircleDot,
  FileDiff,
  Heading2,
  Heading3,
  Bold,
  Italic,
  Strikethrough,
  Code,
  SquareCode,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  Brackets,
  Download,
  Upload,
  ArrowLeftRight,
  ChartSpline,
  EyeOff,
  Grid3x3,
  Hash,
  type IconNode,
} from 'lucide';

/** The icons OpenPurpose uses, by name. Lucide, ISC licensed. */
const ICONS: Partial<Record<string, IconNode>> = {
  'arrow-right': ArrowRight,
  book: BookOpen,
  bot: Bot,
  building: Building2,
  check: Check,
  'chevron-down': ChevronDown,
  'chevrons-up-down': ChevronsUpDown,
  user: CircleUser,
  copy: Copy,
  eye: Eye,
  file: FileText,
  repo: FolderGit2,
  branch: GitBranch,
  inbox: Inbox,
  bug: Bug,
  key: KeyRound,
  layers: Layers,
  grid: LayoutGrid,
  link: Link2,
  lock: Lock,
  unlock: LockOpen,
  logout: LogOut,
  map: MapIcon,
  menu: Menu,
  monitor: Monitor,
  moon: Moon,
  network: Network,
  palette: Palette,
  pencil: Pencil,
  plug: Plug,
  plus: Plus,
  search: Search,
  server: Server,
  settings: Settings,
  share: Share2,
  sun: Sun,
  trash: Trash2,
  users: Users,
  x: X,
  message: MessageSquare,
  history: History,
  dot: CircleDot,
  diff: FileDiff,
  h2: Heading2,
  h3: Heading3,
  bold: Bold,
  italic: Italic,
  strike: Strikethrough,
  code: Code,
  'code-block': SquareCode,
  'list-ul': List,
  'list-ol': ListOrdered,
  'list-task': ListChecks,
  download: Download,
  upload: Upload,
  transfer: ArrowLeftRight,
  quote: Quote,
  brackets: Brackets,
  hash: Hash,
  dots: Grid3x3,
  chart: ChartSpline,
  'eye-off': EyeOff,
};

function esc(v: unknown): string {
  return String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function render(node: IconNode): string {
  return node
    .map(
      ([tag, attrs]) =>
        `<${tag} ${Object.entries(attrs)
          .map(([k, v]) => `${k}="${esc(v)}"`)
          .join(' ')}/>`,
    )
    .join('');
}

@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
  host: { class: 'icon', 'aria-hidden': 'true' },
})
export class Icon {
  readonly name = input.required<string>();
  readonly size = input(16);
  private el = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    effect(() => {
      const node = ICONS[this.name()];
      const s = this.size();
      // Safe: the markup comes from the bundled Lucide icons and a number, never from data.
      // eslint-disable-next-line no-restricted-syntax
      this.el.nativeElement.innerHTML = node
        ? `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${render(node)}</svg>`
        : '';
    });
  }
}
