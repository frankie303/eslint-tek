const b = items.reduce((acc, item) => {
  acc[item.id] = item;
  return acc;
}, {});
