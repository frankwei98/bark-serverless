export class DurableObject<Env> {
  readonly ctx: DurableObjectState;
  readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
