import { DurableObject } from "cloudflare:workers";
import { deviceStorageKey } from "@/services/device-registry-storage";

interface CoordinatorNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

interface CoordinatorStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

interface CoordinatorEnv {
  DEVICE_REGISTRY: CoordinatorNamespace;
}

interface RegistrationState {
  deviceKey: string;
  token: string | null;
}

export interface DeviceRegistryCoordinatorStub {
  deviceTokenByKey(deviceKey: string): Promise<string | null>;
  saveDeviceTokenByKey(deviceKey: string, token: string): Promise<void>;
  deleteDeviceByKey(deviceKey: string, expectedToken?: string): Promise<boolean>;
}

const REGISTRATION_STATE_KEY = "registration";

export class DeviceRegistryCoordinatorCore
  implements DeviceRegistryCoordinatorStub
{
  private operationTail: Promise<void> = Promise.resolve();
  private stateLoaded = false;
  private state: RegistrationState | undefined;

  constructor(
    private readonly storage: CoordinatorStorage,
    private readonly namespace: CoordinatorNamespace,
  ) {}

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const preceding = this.operationTail;
    let release: () => void;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    return (async () => {
      await preceding;
      try {
        return await operation();
      } finally {
        release!();
      }
    })();
  }

  private async readPersistedState(): Promise<RegistrationState | undefined> {
    if (!this.stateLoaded) {
      this.state = await this.storage.get<RegistrationState>(
        REGISTRATION_STATE_KEY,
      );
      this.stateLoaded = true;
    }
    return this.state;
  }

  private assertDeviceKey(state: RegistrationState, deviceKey: string): void {
    if (state.deviceKey !== deviceKey) {
      throw new Error("device registry coordinator key mismatch");
    }
  }

  private async persistState(state: RegistrationState): Promise<void> {
    await this.storage.put(REGISTRATION_STATE_KEY, state);
    this.state = state;
    this.stateLoaded = true;
  }

  private async restoreState(
    state: RegistrationState | undefined,
  ): Promise<void> {
    if (state === undefined) {
      await this.storage.delete(REGISTRATION_STATE_KEY);
    } else {
      await this.storage.put(REGISTRATION_STATE_KEY, state);
    }
    this.state = state;
    this.stateLoaded = true;
  }

  private async legacyToken(deviceKey: string): Promise<string | null> {
    return this.namespace.get(deviceStorageKey(deviceKey));
  }

  async deviceTokenByKey(deviceKey: string): Promise<string | null> {
    return this.runExclusive(async () => {
      const state = await this.readPersistedState();
      if (state === undefined) {
        return this.legacyToken(deviceKey);
      }

      this.assertDeviceKey(state, deviceKey);
      return state.token;
    });
  }

  async saveDeviceTokenByKey(deviceKey: string, token: string): Promise<void> {
    return this.runExclusive(async () => {
      const previous = await this.readPersistedState();
      if (previous !== undefined) {
        this.assertDeviceKey(previous, deviceKey);
      }

      const next = { deviceKey, token: token.length === 0 ? null : token };
      await this.persistState(next);

      try {
        if (token.length === 0) {
          await this.namespace.delete(deviceStorageKey(deviceKey));
        } else {
          await this.namespace.put(deviceStorageKey(deviceKey), token);
        }
      } catch (error) {
        await this.restoreState(previous);
        throw error;
      }
    });
  }

  async deleteDeviceByKey(
    deviceKey: string,
    expectedToken?: string,
  ): Promise<boolean> {
    return this.runExclusive(async () => {
      const previous = await this.readPersistedState();
      if (previous !== undefined) {
        this.assertDeviceKey(previous, deviceKey);
      }

      const currentToken =
        previous === undefined
          ? await this.legacyToken(deviceKey)
          : previous.token;
      if (expectedToken !== undefined && currentToken !== expectedToken) {
        return false;
      }

      await this.persistState({ deviceKey, token: null });
      try {
        await this.namespace.delete(deviceStorageKey(deviceKey));
      } catch (error) {
        await this.restoreState(previous);
        throw error;
      }
      return true;
    });
  }
}

export class DeviceRegistryCoordinator extends DurableObject<CoordinatorEnv> {
  private readonly coordinator: DeviceRegistryCoordinatorCore;

  constructor(ctx: DurableObjectState, env: CoordinatorEnv) {
    super(ctx, env);
    this.coordinator = new DeviceRegistryCoordinatorCore(
      ctx.storage,
      env.DEVICE_REGISTRY,
    );
  }

  deviceTokenByKey(deviceKey: string): Promise<string | null> {
    return this.coordinator.deviceTokenByKey(deviceKey);
  }

  saveDeviceTokenByKey(deviceKey: string, token: string): Promise<void> {
    return this.coordinator.saveDeviceTokenByKey(deviceKey, token);
  }

  deleteDeviceByKey(
    deviceKey: string,
    expectedToken?: string,
  ): Promise<boolean> {
    return this.coordinator.deleteDeviceByKey(deviceKey, expectedToken);
  }
}
