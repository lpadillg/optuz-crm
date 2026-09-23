import { Icon } from "@/components/icons";

export default function InboxIndex() {
  return (
    <div className="empty">
      <div className="empty-state">
        <span className="ico">
          <Icon name="inbox" size={22} />
        </span>
        <strong>Elige una conversación</strong>
        <p className="muted">
          Los chats de WhatsApp llegan aquí. El agente responde solo; tú puedes tomar el control cuando haga falta.
        </p>
      </div>
    </div>
  );
}
