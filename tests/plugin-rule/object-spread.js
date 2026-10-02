const a = items.reduce((acc, item) => ({ ...acc, [item.id]: item }), {});
