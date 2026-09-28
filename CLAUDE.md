# CLAUDE.md

## Proyecto
- Código en `retail-analytics-system/` (backend FastAPI + YOLOv8 en `backend/`, dashboard React/Vite/Tailwind en `frontend/`).
- Tests backend: `cd retail-analytics-system/backend && python -m pytest -q tests`.
- Chequeo frontend: `cd retail-analytics-system/frontend && npm run build`.

## PLANIFY
- Al iniciar sesión preguntá quién habla; si ya se sabe, no.
- Trabajo→crear tarea al empezar; consulta→no. Nombre≤60; nota 1-3 líneas; done=false. Avisar NOMBRE al crear/cerrar, no id.
- Thomas Loekemeyer→employee_id20, prefijo "Th ".
- Al cumplir objetivo: "¿Falta algo más para dar por cerrada la tarea?". Si no→done=true; si falta, abierta: "queda pendiente: …".
- Tras 1h sin mensajes: recordar tareas abiertas si puede programarse; si no, listarlas al cierre.
- Proyecto hrxfctzncixxqmpfhskv, schema planify.
- IDs: Marianela38,Luis52,Gastón61,Tomás20,Gonzalez Tomas16,Elías1,Nazareno27,Angely22,Viviana4,Alan5,Diego44,Nora33,Juan Cruz51,Pablo6,Martín Cornejo34,Martín Pregelj15,Romina55,Iván58,Jhonny46.
- Si falta: SELECT id,nombre FROM planify.employees WHERE activo AND nombre ILIKE '%<apellido>%';
- Alta: INSERT INTO planify.tasks(name,type,prio,time,date,note,rec,done,assignment_type,employee_id,department_id,system_generated,broadcast,created_at,updated_at) VALUES('<resumen ≤60>','tarea','normal','09:00',to_char(now() at time zone 'America/Argentina/Buenos_Aires','YYYY-MM-DD'),'<contexto 1-3 líneas> — cargado desde sesión de Claude','none',false,'employee',<employee_id>,null,false,false,now(),now()) RETURNING id;
- Cierre: UPDATE planify.tasks SET done=true,updated_at=now() WHERE id=<id>;
