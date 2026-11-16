# 360YA Explorer Community v1.0.2

**FREE & OPEN SOURCE FOREVER**

**English:** Free, open-source, self-hosted dual-pane file manager for Debian 13 AMD64. Manage local files and remote SSH/SFTP servers, with a text editor, trash, operation history and an installable PWA.

**Compatibility:** Tested on Debian 13 (Trixie), AMD64, Python 3.13. Other systems and architectures are not yet validated.

[Installation](#2-preparar-debian) · [Report an issue](https://github.com/EL-CHANGO-v4/360ya-explorer-community/issues) · [Contribute](CONTRIBUTING.md)

Explorador de archivos gratuito, de código abierto y autoalojado para Debian GNU/Linux.

360YA Explorer Community permite administrar archivos locales y conectarse a servidores remotos mediante SFTP, utilizando una interfaz web de dos paneles.

**Características principales**

- Explorador de archivos de dos paneles.
- Administración de archivos y carpetas locales.
- Conexión segura a servidores remotos mediante SSH/SFTP.
- Copiar, mover, renombrar, eliminar y restaurar archivos.
- Editor de texto integrado.
- Papelera e historial de operaciones.
- Autenticación mediante contraseña.
- Aplicación web instalable (PWA).
- Licencia MIT, sin suscripciones ni funciones de pago.

---

## 1. Requisitos

Versión preparada para:

- Debian 13 (Trixie), arquitectura AMD64.
- Python 3.13.
- `python3-venv`.
- Git, para descargar el proyecto desde GitHub.
- Navegador web moderno.

El paquete incluye dependencias Python para instalarse sin conexión a Internet una vez descargado, en la plataforma indicada.

## 2. Preparar Debian

Abrí una terminal e instalá los requisitos:

```bash
sudo apt update
sudo apt install -y git python3 python3-venv
```

Comprobá Python:

```bash
python3 --version
```

En Debian 13 debería indicar Python 3.13.x.

## 3. Descargar Explorer desde GitHub

Ejecutá:

```bash
git clone --depth 1 --branch v1.0.2 https://github.com/EL-CHANGO-v4/360ya-explorer-community.git
```

Ingresá al directorio descargado:

```bash
cd 360ya-explorer-community
```

No necesitás descargar ni instalar manualmente paquetes Python.

## 4. Instalar Explorer

Ejecutá:

```bash
bash install.sh
```

El instalador:

1. Crea un entorno virtual Python dentro de `.venv`.
2. Instala las dependencias incluidas en el proyecto.
3. Genera el archivo privado `.env` si todavía no existe.
4. Crea una contraseña inicial aleatoria.
5. Protege `.env` con permisos `0600`.
6. Comprueba la sintaxis del servidor.

**Importante:** la contraseña inicial se genera solamente cuando no existe `.env`. Una instalación nueva no utiliza automáticamente la contraseña de otra instalación anterior.

## 5. Obtener la contraseña inicial

Desde la carpeta de Explorer, ejecutá:

```bash
grep '^EXPLORER_PASSWORD=' .env
```

Copiá únicamente el valor que aparece después de `EXPLORER_PASSWORD=`.

Esa es tu contraseña inicial de Explorer.

**Seguridad:** no compartas esta contraseña, no publiques `.env` en GitHub y no pegues su contenido en chats públicos.

## 6. Iniciar Explorer

Ejecutá:

```bash
bash run.sh
```

Dejá abierta esa terminal mientras utilizás Explorer.

Abrí tu navegador en:

**http://127.0.0.1:8766/explorer**

La versión actual no instala automáticamente un servicio de inicio en segundo plano. Al cerrar el proceso del servidor, Explorer deja de estar disponible.

## 7. Primer ingreso

En la pantalla inicial:

**Usuario de Explorer:** `community`

**Contraseña de Explorer:** la generada durante la instalación.

Para trabajar con archivos locales, pulsá **Continuar en local**.

El nombre de usuario identifica la actividad; la contraseña es la que controla el acceso.

## 8. Conectarse a un servidor remoto

Para utilizar SFTP, completá:

- IP o dominio del servidor.
- Puerto SSH, normalmente `22`.
- Usuario SSH.
- Contraseña SSH o clave privada.

Pulsá **Conectar SFTP**.

Si el servidor SSH es desconocido, verificá su huella SHA-256 antes de confiar en la conexión.

La opción **Recordar estos datos SSH en este navegador** permite guardar el perfil cifrado localmente.

Las operaciones remotas utilizan los permisos de la cuenta SSH correspondiente.

## 9. Cambiar la contraseña de Explorer

Una vez dentro de Explorer:

1. Pulsá **Cambiar contraseña**.
2. Ingresá la contraseña actual.
3. Elegí una contraseña nueva de al menos 12 caracteres.
4. Confirmá el cambio.

Las sesiones existentes se cierran al cambiar la contraseña.

Después de modificarla, la contraseña inicial almacenada en `.env` deja de ser válida para iniciar sesión.

## 10. Utilizar el explorador

Seleccioná archivos o carpetas en cualquiera de los dos paneles.

Las herramientas disponibles permiten crear carpetas, subir archivos, copiar, cortar, pegar, renombrar, buscar y eliminar.

También podés utilizar el editor integrado, consultar el historial y restaurar elementos desde la papelera.

Las operaciones de escritura requieren confirmación mediante la contraseña de Explorer.

## 11. Instalar como aplicación PWA

En un navegador compatible, utilizá el botón **Instalar app**.

Explorer podrá abrirse como aplicación independiente, sin la interfaz habitual del navegador.

La instalación PWA funciona en `localhost` o mediante HTTPS.

**Importante:** la PWA no sustituye al servidor Python. Explorer necesita que su servidor esté ejecutándose.

## 12. Detener Explorer

Si ejecutaste `bash run.sh` en una terminal, presioná:

**Ctrl + C**

Esto detiene el servidor.

No elimina archivos, configuraciones ni contraseñas.

## 13. Cambiar el puerto

Editá el archivo `.env` y modificá:

```ini
EXPLORER_PORT=8766
```

Por ejemplo, para utilizar el puerto `9000`:

```ini
EXPLORER_PORT=9000
```

Guardá el archivo y reiniciá Explorer.

Por defecto, el servidor escucha solamente en `127.0.0.1`, por seguridad.

Para publicar Explorer detrás de un proxy HTTPS se requiere una configuración adicional y `EXPLORER_HTTPS=1`.

## 14. Ejecutar las pruebas

Con Explorer instalado, ejecutá:

```bash
bash install.sh --test
```

Esto ejecuta las pruebas automatizadas del proyecto.

La suite utiliza archivos temporales y servidores de prueba locales.

## 15. Crear un respaldo

Detené Explorer antes de respaldar o restaurar.

Ejecutá:

```bash
bash install.sh --backup
```

Se genera un archivo TAR comprimido y una suma SHA-256 dentro del directorio `backups`.

El respaldo incluye código, configuración y el directorio `data` administrado por el paquete.

**Atención:** puede contener información sensible, incluida la configuración de acceso. Conservá los respaldos en un lugar seguro.

Los archivos de servidores SFTP y los volúmenes externos deben respaldarse por separado.

## 16. Restaurar un respaldo

Con Explorer detenido:

```bash
bash install.sh --rollback backups/NOMBRE_DEL_ARCHIVO.tar.gz
```

Reemplazá `NOMBRE_DEL_ARCHIVO.tar.gz` por el nombre real de tu respaldo.

La restauración verifica previamente su suma SHA-256.

## 17. Actualizaciones

Antes de actualizar:

1. Detené Explorer.
2. Generá un respaldo.
3. Descargá la nueva versión publicada.
4. Revisá sus instrucciones de actualización.
5. Conservá la configuración y los datos de tu instalación anterior.

**Importante:** la v1.0.2 todavía no dispone de un procedimiento automatizado y validado para actualizar una instalación existente conservando todos sus datos. No sobrescribas una instalación anterior sin disponer de un respaldo y un procedimiento de migración.

## 18. Solución de problemas

**No abre la página**

Comprobá que `bash run.sh` esté ejecutándose y que el puerto configurado sea el correcto.

**Contraseña incorrecta después de una instalación nueva**

Comprobá la contraseña inicial de esa instalación en `.env`. La contraseña de otra instalación no se transfiere automáticamente.

**El puerto está ocupado**

Detené el servidor anterior o configurá otro puerto en `.env`.

**No conecta por SFTP**

Revisá la IP, el puerto, las credenciales SSH y la huella del servidor.

**No puedo modificar un archivo**

Comprobá los permisos de la cuenta local o SSH. Explorer respeta los permisos del sistema.

## Comunidad y contribuciones

¡Buscamos usuarios, testers, traductores y desarrolladores de todo el mundo!

- Reportá errores o proponé mejoras mediante [GitHub Issues](https://github.com/EL-CHANGO-v4/360ya-explorer-community/issues).
- Para colaborar con código o documentación, consultá [CONTRIBUTING.md](CONTRIBUTING.md) y enviá un Pull Request.
- Indicá versión, plataforma y pasos para reproducir los problemas; nunca compartas contraseñas, claves SSH ni archivos `.env`.

**Compatibilidad verificada:** Debian 13 AMD64. Ubuntu, otras distribuciones, ARM64, Windows y macOS aún no están validados.

---

## 19. Licencia y filosofía

360YA Explorer Community se distribuye bajo **licencia MIT**.

El proyecto es gratuito, de código abierto y autoalojable.

No requiere suscripciones ni cuentas en servicios externos para funcionar localmente.

**FREE & OPEN SOURCE FOREVER.**

Repositorio oficial:

https://github.com/EL-CHANGO-v4/360ya-explorer-community

---

## 20. Historial de versiones

### v1.0.2

- Nueva identidad visual de 360YA Explorer Community.
- Logo propio en el ingreso, cabecera y ventana «Acerca de».
- Iconos PWA actualizados.
- Actualización de referencias de versión.

### v1.0.1

- Correcciones en el manejo de errores del frontend.
- Mejoras en los diálogos de operaciones.
- Validaciones de seguridad para operaciones de escritura.
- Conexiones SFTP con verificación de identidad del servidor.
- Pruebas de operaciones locales y remotas.

---

**360YA Explorer Community — FREE & OPEN SOURCE FOREVER**
