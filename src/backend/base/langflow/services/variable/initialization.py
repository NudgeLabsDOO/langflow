"""Import deployment credentials for users who predate the current server configuration."""

import os

from sqlmodel import select

from langflow.services.database.models.user.model import User
from langflow.services.deps import get_settings_service, get_variable_service, session_scope


async def initialize_environment_variables() -> None:
    settings = get_settings_service().settings
    if not settings.store_environment_variables or not any(
        os.environ.get(name, "").strip() for name in settings.variables_to_get_from_environment
    ):
        return

    variable_service = get_variable_service()
    last_user_id = None
    while True:
        async with session_scope() as session:
            query = select(User.id).order_by(User.id).limit(100)
            if last_user_id is not None:
                query = query.where(User.id > last_user_id)
            user_ids = (await session.exec(query)).all()
        if not user_ids:
            return

        for user_id in user_ids:
            async with session_scope() as session:
                # Workers/tasks can start together. Serialize each user's import
                # across processes so they cannot create duplicate credentials.
                user = (await session.exec(select(User).where(User.id == user_id).with_for_update())).first()
                if user is not None:
                    await variable_service.initialize_user_variables(user.id, session)
        last_user_id = user_ids[-1]
