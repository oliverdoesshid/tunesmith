import type { HardwareSpec } from '../shared/types';
import type { Executor } from './engine/executor';
import type { GameController } from './engine/game/controller';
import type { JournalStore } from './engine/journal';
import type { SessionLock } from './engine/lock';
import type { PresetRepository } from './engine/preset-repository';
import type { MarketplaceService } from './market/service';

export interface AppState {
  repo: PresetRepository;
  journal: JournalStore;
  lock: SessionLock;
  executor: Executor;
  game: GameController;
  market: MarketplaceService;
  presetsDir: string;
  gameProfilesDir: string;
  sessionsDir: string;
  getSpec(force?: boolean): Promise<HardwareSpec>;
  invalidateSpec(): void;
}
