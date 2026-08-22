const OWNER_WALLET = "0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d";
export async function createOwnerSession(request: Request, submittedCode: string) {
  void request; void submittedCode; return null;
}
export async function hasOwnerSession(request: Request) {
  void request; return false;
}
export function ownerSessionCookie(value: string) { void value; return "plankspace_owner_session=; Path=/; Max-Age=0"; }
export function clearOwnerSessionCookie() { return "plankspace_owner_session=; Path=/; Max-Age=0"; }

export { OWNER_WALLET };
