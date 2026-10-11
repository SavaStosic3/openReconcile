// Display precision must not turn a nonzero reading, uncertainty or inventory
// change into zero. Scientific notation retains four significant digits below
// the ordinary display resolution. Stored and exported numbers are untouched.
export function createQuantityFormatter({ locale, minimumFractionDigits = 0, maximumFractionDigits = 3, scientificAbove = Infinity } = {}) {
  const ordinary = new Intl.NumberFormat(locale, { minimumFractionDigits, maximumFractionDigits });
  const resolution = 10 ** -maximumFractionDigits;
  return value => {
    if (!Number.isFinite(value)) return '—';
    if (value === 0) return ordinary.format(0);
    const magnitude = Math.abs(value);
    return magnitude < resolution || magnitude >= scientificAbove ? value.toExponential(3) : ordinary.format(value);
  };
}

export const formatQuantity = createQuantityFormatter();
