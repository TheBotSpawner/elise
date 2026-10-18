/** The Cloud RPC stubs of a "use server" module (vite.renderer.config.ts). */
declare module "rpc-stub:*" {
  const stubs: Record<string, (...args: unknown[]) => Promise<unknown>>;
  export = stubs;
}
