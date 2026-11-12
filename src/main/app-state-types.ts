import type { HardwareSpec } from '../shared/types';
import type { Executor } from './engine/executor';
import type { GameController } from './engine/game/controller';
import type { JournalStore } from './engine/journal';
import type { SessionLock } from './engine/lock';
import type { PresetRepository } from './engine/preset-repository';
import type { MarketplaceService } from './market/service';
import type { GameLibraryService } from './platform/game/libraries';
import type { ArtworkResolver } from './services/artworkResolver';
import type { SteamGridDbService } from './services/steamgriddb';
import type { HealthWatchdog } from './health/watchdog';
import type { PostApplyWatchdog } from './engine/post-apply';
import type { ShaderCacheService } from './services/shader-cache';

export interface AppState {
  repo: PresetRepository;
  journal: JournalStore;
  lock: SessionLock;
  executor: Executor;
  postApply: PostApplyWatchdog;
  game: GameController;
  libraries: GameLibraryService;
  artwork: SteamGridDbService;
  /** Zero-key local-cache + Steam CDN resolver used by the launcher grid. */
  artworkResolver: ArtworkResolver;
  artworkCacheDir: string;
  health: HealthWatchdog;
  shaderCache: ShaderCacheService;
  market: MarketplaceService;
  presetsDir: string;
  gameProfilesDir: string;
  sessionsDir: string;
  getSpec(force?: boolean): Promise<HardwareSpec>;
  invalidateSpec(): void;
}
