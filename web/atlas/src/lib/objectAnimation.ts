/** Source SetFacing* actions using AlternateStepFrame's two 16-VBlank phases. */
const FRAME_MS = 1000 * 70224 / 4194304;
const FACINGS: Record<string, readonly [string, string]> = {
  SPRITEMOVEDATA_BIG_GYARADOS: ["FACING_BIG_GYARADOS_1", "FACING_BIG_GYARADOS_2"],
  SPRITEMOVEDATA_BIG_HO_OH: ["FACING_BIG_HO_OH_1", "FACING_BIG_HO_OH_2"],
  SPRITEMOVEDATA_BIG_LUGIA: ["FACING_BIG_LUGIA_1", "FACING_BIG_LUGIA_2"],
  SPRITEMOVEDATA_RATTATA_BACK: ["FACING_STEP_DOWN_0", "FACING_STEP_UP_0"],
};

export function getStaticObjectAnimation(movement: string | null | undefined) {
  const facings = FACINGS[movement ?? ""];
  // Select by behavior, not graphics: Rattata's art is also used for static
  // arch decorations in SilverCaveRoom3.
  return facings ? { facings, frameDurationMs: 16 * FRAME_MS } : null;
}
