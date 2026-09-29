# CamarasPanaderia

Integración de las cámaras (DVR) de la panadería con IA.

## PLANIFY
- Al iniciar sesión preguntá quién habla; si ya se sabe, no.
- Trabajo→crear tarea al empezar; consulta→no. Nombre≤60; done=false. Avisar NOMBRE al crear/cerrar, no id.
- Nota con formato fijo: "Falta: <qué hay que hacer>. Pedido de <Nombre> · cargada por Claude, sesión <url>". Al cerrar/actualizar se REESCRIBE, no se agrega encima.
- Thomas Loekemeyer → employee_id 3, prefijo "Th ". Lo transversal va a Tareas T (empleado 3). NUNCA al 20: ése es Tomás Beviglia.
- Cierre por criterio propio y SIN preguntar. PROHIBIDO preguntar "¿Falta algo más para dar por cerrada la tarea?". Si se cumplió→done=true y avisar. Si quedó a medias→abierta con "queda pendiente: …".
- Tras 1h sin mensajes: recordar tareas abiertas si puede programarse; si no, listarlas al cierre.
- Proyecto hrxfctzncixxqmpfhskv, schema planify.
- IDs: Marianela38,Luis52,Gastón61,Tomás Beviglia20,Gonzalez Tomas16,Elías1,Nazareno27,Angely22,Viviana4,Alan5,Diego44,Nora33,Juan Cruz51,Pablo Martos6,Pablo Olejavetzky64,Cornejo34,Pregelj15,Romina55,Iván58,Jhonny46,Thomas3.
- Si falta: SELECT id,nombre FROM planify.employees WHERE activo AND nombre ILIKE '%<apellido>%';
- Alta: INSERT INTO planify.tasks(name,type,prio,time,date,note,rec,done,assignment_type,employee_id,department_id,system_generated,broadcast,created_at,updated_at) VALUES('<resumen ≤60>','tarea','normal','09:00',to_char(now() at time zone 'America/Argentina/Buenos_Aires','YYYY-MM-DD'),'Falta: <qué>. Pedido de <Nombre> · cargada por Claude, sesión <url>','none',false,'employee',<employee_id>,null,false,false,now(),now()) RETURNING id;
- Cierre: UPDATE planify.tasks SET done=true,updated_at=now() WHERE id=<id>;

## COMMITS
- Todo commit lleva: Hecho-por: <Nombre> (employee_id N) — el que HACE, no el que pide.
- Sólo si difiere, agregar: Pedido-por: <Nombre>.
