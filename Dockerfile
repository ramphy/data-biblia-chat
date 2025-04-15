# Usa una imagen base de Node.js
FROM node:bullseye-slim

RUN apt update

RUN apt install -y ffmpeg
# Establece el directorio de trabajo en el contenedor
WORKDIR /usr/src/app

# Copia los archivos package.json y package-lock.json (si está disponible)
COPY package*.json ./

# Instala las dependencias del proyecto
RUN npm install
# Copia los archivos del proyecto al directorio de trabajo
COPY . .

# Expone el puerto en el que tu aplicación se ejecutará
EXPOSE 1020

# Define el comando para ejecutar la aplicación (servidor y worker) usando concurrently
CMD [ "npm", "run", "start" ]
