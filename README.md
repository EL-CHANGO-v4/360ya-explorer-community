# 360YA Explorer Community 1.0.1

Administrador de archivos autoalojado con dos paneles, editor e historial. Licencia MIT. Incluye A-Frame y las dependencias Python para instalar sin red en Debian 13 amd64 con Python 3.13 y `python3-venv`.

Desde el directorio que se crea al descomprimir, ejecutá **`bash install.sh && bash run.sh`** y abrí [Explorer local](http://127.0.0.1:8766/explorer). El instalador genera la contraseña de Explorer en `EXPLORER_PASSWORD` dentro de `.env`, con permisos 0600. El nombre de usuario del formulario identifica la actividad. La contraseña controla el acceso. Podés cambiar el puerto con `EXPLORER_PORT` en `.env`.

El modo local muestra los volúmenes de `data`. Para SFTP, completá host, puerto, usuario y la contraseña SSH o clave privada en la pantalla inicial. Pulsá **Conectar SFTP**. Si elegís recordar la conexión, el perfil queda cifrado en ese navegador. Si el servidor no figura en `known_hosts`, compará la huella SHA-256 con la que proporciona tu administrador antes de ingresarla. Los datos SSH se mantienen en memoria del servidor durante la sesión. **Desconectar SFTP** elimina los datos de conexión de la sesión. Las operaciones remotas empiezan en el directorio inicial de la cuenta SSH y respetan los permisos de esa cuenta.

**Cambiar contraseña** pide la contraseña actual y cierra las sesiones al guardar la nueva. La contraseña inicial de `.env` deja de servir después del cambio. **Acerca de** muestra la versión y los créditos.

Cada escritura requiere la contraseña de Explorer. Para copiar o mover desde la barra, seleccioná uno o más elementos, pulsá **Copiar** o **Cortar**, activá el panel de destino y pulsá **Pegar**. En SFTP, la papelera reside en `.trash` del directorio inicial remoto. Debe ser escribible por la cuenta SSH. La capacidad del volumen se muestra en el modo local.

Para verificar el programa, ejecutá `bash install.sh --test`. La suite copia los datos de ejemplo a un directorio temporal y abre servidores HTTP y SSH en loopback. Para una instalación accesible desde otra máquina se requiere un proxy HTTPS y `EXPLORER_HTTPS=1`.

Para respaldar o restaurar, cerrá esta instancia de Explorer primero. Usá `bash install.sh --backup` para generar el TAR y su SHA-256, y `bash install.sh --rollback backups/ARCHIVO.tar.gz` para restaurarlos. El respaldo incluye la configuración, el código y el directorio `data` que trae el paquete. Los volúmenes SFTP y las rutas de datos externas se respaldan por separado. Los respaldos contienen la contraseña de Explorer de esa instalación y se guardan con permisos 0600.

En un navegador compatible, usá **Instalar app** para agregar Explorer al escritorio como PWA. La instalación funciona en localhost o HTTPS. Explorer requiere conexión con el servidor y no guarda archivos ni sesiones para usar sin conexión.

## Cambios y pruebas

- El frontend de v1.0 descartaba el campo `detail` que devolvía FastAPI. Una operación en la raíz local de solo lectura generaba 403 y se mostraba como «Solicitud rechazada». El panel ahora abre en el volumen escribible `trabajo` y la interfaz muestra la causa que devuelve el servidor. También se corrigió el evento de cierre que podía vaciar un diálogo de papelera recién abierto.
- `prepare` y `execute` vinculan el nonce de un solo uso a la sesión, la operación, la conexión SFTP, el estado de las rutas y el contenido de una subida. La ejecución exige contraseña y token CSRF.
- SSH verifica la identidad del servidor y admite contraseña o clave privada desde el formulario. SFTP implementa listado, búsqueda, subida y descarga, edición, permisos, copia y movimiento, creación y papelera con restauración. Se probaron por HTTP usando un servidor SSH/SFTP de prueba en loopback y archivos reales.
- En el navegador se comprobó la selección múltiple de ambos paneles, la eliminación de una carpeta y la lectura de un archivo en el subdirectorio restaurado.
