// Customer-facing server strings (push, email, timeline). App UI strings live in the iOS bundle.
const strings = {
  en: {
    att_billing_notice: 'Your AT&T service charges are billed separately by AT&T.',
    magic_subject: 'Your DealerDoor sign-in link',
    magic_body: (link: string) => `Tap to sign in (expires in 15 minutes):\n\n${link}\n\nIf you didn't request this, ignore this email.`,
    stage_order_received: 'Order received',
    stage_install_scheduled: 'Install scheduled',
    stage_installed: 'Installed',
    stage_activated: 'Activated',
    stage_feedback_available: 'Feedback available',
    push_stage_title: 'Order update',
    push_stage_body: (stage: string) => `${stage} — open DealerDoor for details.`,
    push_feedback_title: 'How did we do?',
    push_feedback_body: 'Your service is active. Rate your experience in the Feedback tab.',
    push_invoice_title: 'New invoice',
    push_invoice_body: (amount: string, due: string) => `${amount} due ${due}.`,
    cancel_request_subject: 'Order cancellation request',
    cancel_request_body: (order: string, address: string, reason: string) =>
      `A customer asked to cancel order ${order}${address ? ` (${address})` : ''}.\n\nReason: ${reason || 'none given'}\n\nOpen the order in the admin console to approve (Cancel order) or contact the customer.`,
    remind_title: 'Payment reminder',
    remind_body: { 'T-3': (a: string, d: string) => `${a} is due in 3 days (${d}).`, T0: (a: string) => `${a} is due today.`, 'T+7': (a: string) => `${a} is 7 days past due.`, 'T+30': (a: string) => `${a} is 30 days past due. Please contact us.` },
  },
  es: {
    att_billing_notice: 'Los cargos de su servicio de AT&T los factura AT&T por separado.',
    magic_subject: 'Su enlace para iniciar sesión en DealerDoor',
    magic_body: (link: string) => `Toque para iniciar sesión (vence en 15 minutos):\n\n${link}\n\nSi no lo solicitó, ignore este correo.`,
    stage_order_received: 'Pedido recibido',
    stage_install_scheduled: 'Instalación programada',
    stage_installed: 'Instalado',
    stage_activated: 'Activado',
    stage_feedback_available: 'Opiniones disponibles',
    push_stage_title: 'Actualización del pedido',
    push_stage_body: (stage: string) => `${stage}: abra DealerDoor para ver detalles.`,
    push_feedback_title: '¿Qué tal lo hicimos?',
    push_feedback_body: 'Su servicio está activo. Califique su experiencia en la pestaña Opiniones.',
    push_invoice_title: 'Nueva factura',
    push_invoice_body: (amount: string, due: string) => `${amount} vence el ${due}.`,
    cancel_request_subject: 'Solicitud de cancelación de pedido',
    cancel_request_body: (order: string, address: string, reason: string) =>
      `Un cliente pidió cancelar el pedido ${order}${address ? ` (${address})` : ''}.\n\nMotivo: ${reason || 'no indicó'}\n\nAbra el pedido en la consola de administración para aprobarlo (Cancel order) o comuníquese con el cliente.`,
    remind_title: 'Recordatorio de pago',
    remind_body: { 'T-3': (a: string, d: string) => `${a} vence en 3 días (${d}).`, T0: (a: string) => `${a} vence hoy.`, 'T+7': (a: string) => `${a} tiene 7 días de atraso.`, 'T+30': (a: string) => `${a} tiene 30 días de atraso. Comuníquese con nosotros.` },
  },
};

export type Locale = keyof typeof strings;
export const t = (locale: string | null | undefined) => strings[locale === 'es' ? 'es' : 'en'];

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
