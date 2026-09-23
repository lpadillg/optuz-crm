# Cómo cargar una promoción

Una promoción en el CRM son **cuatro datos**, no un texto largo: título, descripción, vigencia y en qué
sucursales aplica. El agente solo las menciona si salen de aquí, así que lo que no esté escrito no existe.

## Los campos

| Campo | Qué es | Regla |
|---|---|---|
| **Título** | Cómo se llama la oferta | Máximo 8 palabras. Tiene que decir qué se lleva el cliente, no el nombre interno de la campaña |
| **Descripción** | Lo que el agente le explicará al cliente | 3 a 5 líneas. Se escribe hablándole al cliente, de tú |
| **Vigencia** | Desde cuándo y hasta cuándo | El agente deja de ofrecerla solo al terminar. No hace falta acordarse de apagarla |
| **Sucursal** | Una tienda o todas | Si es de una sola, el agente no la menciona a clientes de otra |

## La descripción, en este orden

1. **Qué se lleva**, en una frase. Lo primero y lo más claro.
2. **Qué incluye exactamente**, sobre todo si hay algo que suele malentenderse (¿el segundo par lleva montura
   o solo las lunas?). Aquí se evitan las discusiones en tienda.
3. **Las variantes**, si hay más de una.
4. **Cómo se empieza** (la evaluación visual gratuita, traer la receta, etc.).
5. **La condición**, si la hay: cupos limitados, solo primera compra, etc.

## Qué NO va en una promoción

- **Precios.** El agente no da precios por diseño: dependen de la medida y de la montura, y un número suelto
  por WhatsApp acaba en una discusión en el mostrador. El precio se ve en la tienda.
- **Direcciones, horarios y sucursales.** Ya están en el sistema y se actualizan desde Sucursales. Repetirlos
  en la promoción hace que un día digan cosas distintas.
- **Cómo agendar, el tono o el formato de los mensajes.** Eso es el comportamiento del agente, no una oferta.
  Va en el prompt y en las pruebas, no en una ficha que caduca.
- **Explicar qué es un tratamiento o un tipo de luna.** Eso no caduca con la promoción: va en Conocimiento,
  para que siga sirviendo cuando la oferta termine.

## Ejemplo

> **Título:** 2x1: el segundo par completo, gratis
>
> **Descripción:** Por la compra de tus lentes te llevas un segundo par completo —montura y lunas—
> totalmente gratis. Hay dos combos: compras tus lunas *Blue Block* (filtro de luz azul) y te llevas un
> *Antireflex* gratis, o compras tus *Blue Defense* (fotocromático con filtro de luz azul) y te llevas otro
> *Blue Defense* gratis. Aplica en las cinco tiendas y empieza con tu evaluación visual gratuita: no
> necesitas receta previa. Cupos limitados.
>
> **Vigencia:** 18 → 26 de septiembre · **Sucursal:** todas

## Antes de activarla

Cárgala **desactivada**, léela como si fueras el cliente y pregúntate si podrías reclamar algo que no
quisiste prometer. Al activarla, el agente empieza a ofrecerla en la siguiente conversación.
