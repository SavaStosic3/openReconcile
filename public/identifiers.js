// Diagram item IDs travel unchanged through model files, SQL and PI mappings.
// SQL result schemas reserve 128 characters; count UTF-16 code units so the
// same limit also fits SQL Server's NVARCHAR(128).
export const MAX_PORTABLE_ID_LENGTH = 128;

export function validatePortableId(value, label = 'Item ID') {
  if (typeof value !== 'string' || !value || value.length > MAX_PORTABLE_ID_LENGTH
    || value !== value.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(value)
    || Array.from(value).some(character => {
      const point = character.codePointAt(0);
      return point >= 0xd800 && point <= 0xdfff;
    })) {
    throw new Error(`${label} must contain 1–${MAX_PORTABLE_ID_LENGTH} characters, without surrounding whitespace, control characters, or malformed Unicode.`);
  }
  return value;
}
