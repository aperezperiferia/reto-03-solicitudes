# Conocimiento operativo

El maestro es la única fuente de datos empresariales. Los sinónimos del glosario se mapean automáticamente. Para CO el identificador tributario es NIT; para EC, PE y PA es RUC; para HN es RTN. Como el maestro solo contiene NIT colombiano, el valor se puede preparar para países extranjeros, pero debe quedar en `requiere_confirmacion` con la nota `identificador extranjero`.

Los datos bancarios solo se muestran si la plantilla los solicita y nunca se incluyen en el borrador de correo. Soportes ausentes o vencidos bloquean la preparación para firma. Los campos faltantes no bloquean el paquete, pero deben reportarse. El envío se simula solo tras confirmación explícita en el turno anterior.
