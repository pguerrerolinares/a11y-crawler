const ACTION_BLACKLIST = [
  /log\s*out/i, /sign\s*out/i, /cerrar\s*sesi[oó]n/i,
  /delete/i, /eliminar/i, /borrar/i, /remove/i,
  /submit/i, /enviar/i, /send/i,
  /buy/i, /comprar/i, /purchase/i, /pay/i, /pagar/i, /checkout/i,
  /download/i, /descargar/i,
  /subscribe/i, /suscribir/i, /unsubscribe/i,
  /cookie/i, /consent/i, /gdpr/i, /accept.*cookie/i,
];

const URL_BLACKLIST = [
  /\.(pdf|docx?|xlsx?|pptx?|zip|rar|tar|gz)$/i,
  /\.(jpe?g|png|gif|svg|webp|ico|mp[34]|avi|mov|webm)$/i,
  /\.(css|js|json|xml|txt|woff2?|ttf|eot)$/i,
  /^mailto:/i,
  /^tel:/i,
  /^javascript:/i,
  /#$/,
];

export function isBlacklistedAction(description: string): boolean {
  return ACTION_BLACKLIST.some((pattern) => pattern.test(description));
}

export function isBlacklistedUrl(url: string): boolean {
  return URL_BLACKLIST.some((pattern) => pattern.test(url));
}
