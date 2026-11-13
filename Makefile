-include local.mk
NAME := tg-gateway
DEST ?= /opt/$(NAME)
# Unidad de sistema (deploy/$(NAME).service.example): la instala el administrador
# y no vive en este repo. El comentario va en su propia línea: en la misma, los
# espacios que lo preceden quedan dentro del valor.
SERVICE := $(NAME)

# Sin .PHONY, `make deploy` no hace nada: existe un directorio deploy/ y make da
# el target por actualizado.
.PHONY: deploy restart status logs

deploy:
	pnpm build && \
	  rsync -av dist/ $(DEST)/dist/ && \
	  cp package.json pnpm-lock.yaml $(DEST)/
	cd $(DEST) && rm -rf node_modules && CI=true pnpm install --prod --no-frozen-lockfile
	sudo systemctl restart $(SERVICE).service

restart:
	sudo systemctl restart $(SERVICE).service

status:
	sudo systemctl status $(SERVICE).service --no-pager

logs:
	journalctl -u $(SERVICE).service -n 50 -f
