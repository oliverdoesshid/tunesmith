import type { HardwareSpec } from '../shared/types';
import type { Executor } from './engine/executor';
import type { GameController } from './engine/game/controller';
import type { JournalStore } from './engine/journal';
import type { SessionLock } from './engine/lock';
import type { PresetRepository } from './engine/preset-repository';
import type { MarketplaceService } from './market/service';
import type { GameLibraryService } from './platform/game/libraries';
import type { SteamGridDbService } from './services/steamgriddb';
import type { HealthWatchdog } from './health/watchdog';
import type { PostApplyWatchdog } from './engine/post-apply';

export interface AppState {
  repo: PresetRepository;
  journal: JournalStore;
  lock: SessionLock;
  executor: Executor;
  postApply: PostApplyWatchdog;
  game: GameController;
  libraries: GameLibraryService;
  artwork: SteamGridDbService;
  artworkCacheDir: string;
  health: HealthWatchdog;
  market: MarketplaceService;
  presetsDir: string;
  gameProfilesDir: string;
  sessionsDir: string;
  getSpec(force?: boolean): Promise<HardwareSpec>;
  invalidateSpec(): void;
}
